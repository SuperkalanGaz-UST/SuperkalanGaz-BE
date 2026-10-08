#!/usr/bin/env python3
"""Docker backup/restore with optional GCS upload; never provisions cloud resources."""

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

BASE = Path(__file__).resolve().parents[1]


def run(command, *, env=None, data=None, stdout=subprocess.PIPE, timeout=600):
    result = subprocess.run(command, input=data, stdout=stdout,
                            stderr=subprocess.PIPE, env=env, timeout=timeout)
    if result.returncode:
        # Docker/MySQL diagnostics can contain credentials or SQL. Keep them private.
        raise RuntimeError(f"{Path(command[0]).name} failed (exit {result.returncode}); payload withheld")
    return result.stdout


class Stack:
    def __init__(self, project, env_file, files=None):
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,80}", project):
            raise ValueError("Use an explicit, valid Compose project name")
        self.project = project
        self.env_file = Path(env_file).resolve(strict=True)
        if self.env_file.stat().st_mode & 0o077:
            raise ValueError("Environment file must have permissions 600 or stricter")
        # An operator's shell must not override the explicitly selected env file.
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(("MYSQL_", "TRACCAR_", "COMPOSE_"))}
        self.prefix = ["docker", "compose", "--project-directory", str(BASE),
                       "--env-file", str(self.env_file), "-p", project]
        for file in files or [BASE / "compose.yaml"]:
            self.prefix += ["-f", str(file)]
        self.prefix += ["--profile", "private-api"]

    def compose(self, *args, **kwargs):
        return run(self.prefix + list(args), env=self.env, **kwargs)

    def services(self):
        return self.compose("ps", "--services", "--status", "running").decode().split()

    def sql(self, query):
        return self.compose("exec", "-T", "database", "sh", "-c",
                            'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql '
                            '-u "$MYSQL_USER" -N -B "$MYSQL_DATABASE"',
                            data=query.encode()).decode().strip()

    def stop(self, services):
        if services:
            self.compose("stop", "--timeout", "30", *services)


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def backup(stack, output, stop_after=False, gcs_prefix=None, remove_local=False):
    """Quiesce writers, export SQL+config, optionally upload, resume or stop."""
    output = Path(output).resolve()
    if remove_local and not gcs_prefix:
        raise ValueError("Removing a local backup requires successful GCS upload")
    if gcs_prefix and not re.fullmatch(r"gs://[a-z0-9][a-z0-9._-]+(?:/[A-Za-z0-9/_-]*)?", gcs_prefix):
        raise ValueError("Use an explicit GCS bucket/prefix with no glob or query")
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    if output.stat().st_mode & 0o077:
        raise ValueError("Backup destination must have permissions 700")
    active = stack.services()
    if "database" not in active or "traccar" not in active:
        raise ValueError("Database and Traccar must be running for a backup")
    writers = [name for name in active if name in ("private-api-proxy", "traccar")]
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    archive = output / f"{stack.project}-{stamp}.tar.gz"
    completed = False
    try:
        stack.stop(writers)
        with tempfile.TemporaryDirectory(prefix="traccar-backup-", dir=output) as temp:
            staging = Path(temp)
            sql_file = staging / "database.sql.gz"
            # Root needed by mysqldump metadata queries; password stays inside container.
            raw_file = staging / "database.sql"
            with raw_file.open("wb") as stream:
                stack.compose("exec", "-T", "database", "sh", "-c",
                              'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump '
                              '-u root --single-transaction --quick --no-tablespaces '
                              '--set-gtid-purged=OFF --skip-add-drop-table '
                              '"$MYSQL_DATABASE"', stdout=stream)
            with raw_file.open("rb") as source, gzip.open(sql_file, "wb") as target:
                shutil.copyfileobj(source, target)
            raw_file.unlink()
            model = json.loads(stack.compose("config", "--format", "json"))
            metadata = {"project": stack.project, "created_utc": stamp,
                        "database_sha256": sha(sql_file),
                        "images": {k: v["image"] for k, v in model["services"].items()}}
            (staging / "manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
            config = staging / "config"
            config.mkdir(mode=0o700)
            # Save effective model as well as source files so overrides remain recoverable.
            (config / "compose.resolved.json").write_text(json.dumps(model, indent=2))
            (config / "runtime.env").write_bytes(stack.env_file.read_bytes())
            (config / "compose.yaml").write_bytes((BASE / "compose.yaml").read_bytes())
            (config / "traccar-api.conf").write_bytes((BASE / "nginx/traccar-api.conf").read_bytes())
            (config / "nginx.conf").write_bytes((BASE / "nginx/nginx.conf").read_bytes())
            if (BASE / "certs/ca.crt").is_file():
                (config / "ca.crt").write_bytes((BASE / "certs/ca.crt").read_bytes())
            proxy = model["services"].get("private-api-proxy", {})
            for mount in proxy.get("volumes", []):
                if mount.get("target") in ("/etc/nginx/certs/tls.crt", "/etc/nginx/certs/tls.key"):
                    (config / Path(mount["target"]).name).write_bytes(Path(mount["source"]).read_bytes())
            tar_path = staging / "backup.tar.gz"
            with tarfile.open(tar_path, "w:gz") as tar:
                for name in ("database.sql.gz", "manifest.json", "config"):
                    tar.add(staging / name, arcname=name)
            tar_path.rename(archive)
            archive.chmod(0o600)
            checksum = archive.with_suffix(archive.suffix + ".sha256")
            checksum.write_text(f"{sha(archive)}  {archive.name}\n")
            checksum.chmod(0o600)
        if gcs_prefix:
            # Gcloud needs destination get/list; bucket-scoped IAM grants no delete.
            # Generation zero prevents overwriting an existing archive.
            for file in (archive, checksum):
                run(["gcloud", "storage", "cp", str(file),
                     gcs_prefix.rstrip("/") + "/" + file.name,
                     "--if-generation-match=0", "--quiet"])
            receipt = archive.with_suffix(archive.suffix + ".upload.json")
            receipt.write_text(json.dumps({"archive": archive.name, "sha256": sha(archive),
                               "destination": gcs_prefix.rstrip("/") + "/" + archive.name,
                               "uploaded_utc": dt.datetime.now(dt.timezone.utc).isoformat()}, indent=2) + "\n")
            receipt.chmod(0o600)
            if remove_local:
                archive.unlink()
                checksum.unlink()
        completed = True
        if stop_after:
            stack.stop(["database"])
        return archive
    finally:
        if not (stop_after and completed):
            stack.compose("up", "-d", "--wait", "--wait-timeout", "600", *writers)


def unpack(archive, destination):
    archive = Path(archive).resolve(strict=True)
    expected = archive.with_suffix(archive.suffix + ".sha256").read_text().split()[0]
    if sha(archive) != expected:
        raise ValueError("Archive checksum mismatch")
    destination = Path(destination).resolve()
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    allowed = {"database.sql.gz", "manifest.json", "config", "config/compose.resolved.json",
               "config/runtime.env", "config/compose.yaml", "config/traccar-api.conf",
               "config/tls.crt", "config/tls.key", "config/nginx.conf", "config/ca.crt"}
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        if any(m.name not in allowed or not (m.isfile() or m.isdir()) for m in members):
            raise ValueError("Unexpected archive member")
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(mode=0o700, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o700, exist_ok=True)
                with tar.extractfile(member) as source, target.open("wb") as stream:
                    shutil.copyfileobj(source, stream)
                target.chmod(0o600)
    manifest = json.loads((destination / "manifest.json").read_text())
    if sha(destination / "database.sql.gz") != manifest["database_sha256"]:
        raise ValueError("Database export checksum mismatch")


def restore(stack, directory):
    directory = Path(directory).resolve(strict=True)
    manifest = json.loads((directory / "manifest.json").read_text())
    sql_file = directory / "database.sql.gz"
    if sha(sql_file) != manifest["database_sha256"]:
        raise ValueError("Database export checksum mismatch")
    if set(stack.services()) != {"database"}:
        raise ValueError("Restore requires ONLY the destination database running")
    if stack.sql("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE();") != "0":
        raise ValueError("Refusing to restore into a nonempty database")
    # No DROP/database replacement. A failed import leaves target for diagnosis.
    with tempfile.TemporaryDirectory(prefix="restore-", dir=directory) as temp:
        raw_file = Path(temp) / "database.sql"
        with gzip.open(sql_file, "rb") as source, raw_file.open("wb") as target:
            shutil.copyfileobj(source, target)
        command = stack.prefix + ["exec", "-T", "database", "sh", "-c",
                                 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql '
                                 '-u "$MYSQL_USER" "$MYSQL_DATABASE"']
        with raw_file.open("rb") as source:
            result = subprocess.run(command, stdin=source, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, env=stack.env, timeout=600)
        if result.returncode:
            raise RuntimeError("Database restore failed; diagnostics withheld")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--env-file", required=True)
    sub = parser.add_subparsers(dest="action", required=True)
    export = sub.add_parser("backup")
    export.add_argument("--output", required=True)
    export.add_argument("--stop-after-backup", action="store_true")
    export.add_argument("--gcs-prefix")
    export.add_argument("--remove-local-after-upload", action="store_true")
    decrypt = sub.add_parser("unpack")
    decrypt.add_argument("--archive", required=True)
    decrypt.add_argument("--destination", required=True)
    recover = sub.add_parser("restore-empty")
    recover.add_argument("--directory", required=True)
    args = parser.parse_args()
    if args.action == "unpack":
        unpack(args.archive, args.destination)
        print("Backup and export checksums verified in protected destination")
    else:
        stack = Stack(args.project, args.env_file)
        if args.action == "backup":
            archive = backup(stack, args.output, args.stop_after_backup,
                             args.gcs_prefix, args.remove_local_after_upload)
            print(f"Backup completed: {archive.name}")
            if args.gcs_prefix:
                print("GCS upload succeeded; protected local receipt saved")
            if args.stop_after_backup:
                print("Compose containers stopped; volumes preserved. VM/disk/IP charges are NOT stopped.")
        else:
            restore(stack, args.directory)
            print("Database restored into previously empty destination; start Traccar and verify API")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"Operation failed: {type(error).__name__}; secret diagnostics withheld") from None
