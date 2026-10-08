#!/usr/bin/env python3
"""Disposable linux/amd64 TLS, H02, persistence, backup/restore drill."""

import datetime as dt
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import traceback
import urllib.parse
from unittest.mock import patch

import operations

from operations import BASE, Stack, backup, restore, run, unpack


def certificate(directory, name, *, ca=None, san=None):
    key, cert = directory / f"{name}.key", directory / f"{name}.crt"
    if ca is None:
        run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
             "-subj", f"/CN=Disposable {name}", "-keyout", str(key), "-out", str(cert)])
    else:
        csr, ext = directory / f"{name}.csr", directory / f"{name}.ext"
        ext.write_text(f"subjectAltName=IP:{san}\nbasicConstraints=CA:FALSE\n"
                       "keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
        run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj",
             f"/CN={san}", "-keyout", str(key), "-out", str(csr)])
        run(["openssl", "x509", "-req", "-in", str(csr), "-CA", str(ca[1]),
             "-CAkey", str(ca[0]), "-CAcreateserial", "-days", "2", "-extfile", str(ext),
             "-CAserial", str(directory / "ca.srl"),
             "-out", str(cert)])
    key.chmod(0o600)
    cert.chmod(0o600)
    return key, cert


class Client:
    def __init__(self, port, ca):
        self.port, self.ca, self.cookie = port, ca, None

    def request(self, method, path, payload=None, form=False, *, trusted=True, hostname="10.60.0.10"):
        context = ssl.create_default_context(cafile=str(self.ca) if trusted else None)
        connection = http.client.HTTPSConnection(hostname, timeout=15, context=context)
        # Reach loopback locally while validating the exact planned VM IP SAN.
        connection.sock = context.wrap_socket(socket.create_connection(("127.0.0.1", self.port), 15),
                                              server_hostname=hostname)
        headers = {}
        body = None
        if self.cookie:
            headers["Cookie"] = self.cookie
        if payload is not None:
            body = urllib.parse.urlencode(payload) if form else json.dumps(payload)
            headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        cookie = response.getheader("Set-Cookie")
        if cookie:
            self.cookie = cookie.split(";", 1)[0]
        data = response.read()
        status = response.status
        content_type = response.getheader("Content-Type", "")
        connection.close()
        return status, json.loads(data) if data and status < 300 and "application/json" in content_type else None


def main():
    os.umask(0o077)
    runtime = BASE / ".runtime"
    runtime.mkdir(mode=0o700, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="smoke-", dir=runtime))
    identifier = "traccar-smoke-" + secrets.token_hex(6)
    summary = {"started_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
               "platform": "linux/amd64", "projects": [identifier, identifier + "-restore"],
               "checks": [], "status": "failed", "cleanup": []}
    stacks = []
    def passed(name):
        summary["checks"].append(name)
        print(f"PASS {name}", flush=True)
    try:
        ca = certificate(directory, "ca")
        key, cert = certificate(directory, "server", ca=ca, san="10.60.0.10")
        password = secrets.token_hex(24)
        env = directory / "runtime.env"
        env.write_text(f"MYSQL_DATABASE=traccar\nMYSQL_USER=traccar\nMYSQL_PASSWORD={password}\n"
                       f"MYSQL_ROOT_PASSWORD={secrets.token_hex(24)}\nTRACCAR_DEVICE_PORT=5013\n"
                       "TRACCAR_VM_PRIVATE_IP=127.0.0.1\nTRACCAR_DEVICE_BIND_IP=127.0.0.1\n"
                       f"TRACCAR_TLS_CERT_FILE={cert}\nTRACCAR_TLS_KEY_FILE={key}\n")
        env.chmod(0o600)
        override = directory / "compose.smoke.yaml"
        override.write_text("services:\n  traccar:\n    ports: !override\n"
                            "      - '127.0.0.1::5013/tcp'\n"
                            "  private-api-proxy:\n    ports: !override\n"
                            "      - '127.0.0.1::443/tcp'\n")
        files = [BASE / "compose.yaml", override]
        source = Stack(identifier, env, files)
        target = Stack(identifier + "-restore", env, files)
        stacks = [source, target]
        source.compose("config", "--quiet")
        source.compose("up", "-d", "--wait", "--wait-timeout", "600")
        passed("Compose healthy (MySQL + Traccar wget + NGINX)")
        model = json.loads(source.compose("config", "--format", "json"))
        summary["images"] = {name: service["image"] for name, service in model["services"].items()}
        limits = sum(int(service.get("mem_limit", 0)) for service in model["services"].values())
        assert limits <= 1536 * 1024 * 1024
        summary["container_memory_limit_mib"] = limits // (1024 * 1024)
        assert not model["services"]["database"].get("ports")
        assert len(model["services"]["traccar"]["ports"]) == 1
        passed("Memory limits <= 1.5 GiB; no MySQL/raw API host bindings")
        def client(stack):
            port = int(stack.compose("port", "private-api-proxy", "443").decode().strip().rsplit(":", 1)[1])
            return Client(port, ca[1])
        api = client(source)
        assert api.request("GET", "/api/health")[0] == 200
        for options in ({"trusted": False}, {"hostname": "10.60.0.11"}):
            try:
                api.request("GET", "/api/health", **options)
            except ssl.SSLCertVerificationError:
                continue
            raise AssertionError("TLS verification unexpectedly succeeded")
        passed("Private CA + IP SAN accepted; untrusted CA/wrong IP rejected")
        assert api.request("GET", "/api/devices")[0] == 401
        admin_password = secrets.token_hex(24)
        assert api.request("POST", "/api/users", {"name": "Disposable operator",
                           "email": "smoke@example.invalid", "password": admin_password})[0] in (200, 201)
        login = {"email": "smoke@example.invalid", "password": admin_password}
        assert api.request("POST", "/api/session", login, True)[0] == 200
        server_status, server = api.request("GET", "/api/server")
        assert server_status == 200
        server["registration"] = False
        assert api.request("PUT", "/api/server", server)[0] == 200
        anonymous = client(source)
        assert anonymous.request("POST", "/api/users", {"name": "Rejected registrant",
                                 "email": "blocked@example.invalid", "password": secrets.token_hex(24)})[0] in (400, 401, 403)
        passed("Server registration=false blocks anonymous account creation")
        status, device = api.request("POST", "/api/devices", {"name": "Disposable H02", "uniqueId": "1234567890"})
        assert status in (200, 201)
        passed("Unauthenticated devices rejected; authenticated provisioning succeeds")
        port = int(source.compose("port", "traccar", "5013").decode().strip().rsplit(":", 1)[1])
        # Synthetic fixture shaped like upstream H02ProtocolDecoderTest, with current UTC.
        now = dt.datetime.now(dt.timezone.utc)
        packet = (f"*HQ,1234567890,V1,{now:%H%M%S},A,1435.0000,N,12100.0000,E,0.00,0,"
                  f"{now:%d%m%y},FFFFFBFF#").encode()
        with socket.create_connection(("127.0.0.1", port), 10) as device_socket:
            device_socket.sendall(packet)
            for _ in range(30):
                status, positions = api.request("GET", "/api/positions")
                if status == 200 and any(p["deviceId"] == device["id"] and p["protocol"] == "h02" for p in positions):
                    break
                time.sleep(1)
            else:
                raise AssertionError("H02 position not ingested")
        position_id = next(p["id"] for p in positions if p["deviceId"] == device["id"])
        passed("Synthetic H02 TCP 5013 position persisted and returned by authenticated API")
        ids = source.compose("ps", "-q").decode().split()
        # State output only; never inspect Config.Env or print health payloads.
        for cid in ids:
            state = json.loads(run(["docker", "inspect", "--format", "{{json .State}}", cid]))
            assert not state["OOMKilled"]
        summary["docker_stats"] = run(["docker", "stats", "--no-stream", "--format",
                                       "{{.Name}}: {{.MemUsage}} / {{.CPUPerc}}", *ids]).decode().splitlines()
        source.compose("restart", "traccar")
        source.compose("up", "-d", "--wait", "--wait-timeout", "600")
        api = client(source)
        assert api.request("POST", "/api/session", login, True)[0] == 200
        assert any(p["id"] == position_id for p in api.request("GET", "/api/positions")[1])
        passed("Container restart preserves account, device and latest position")
        failed_uploads = directory / "failed-upload"
        original_run = operations.run
        def fail_upload(command, **kwargs):
            if command[0] == "gcloud":
                raise RuntimeError("Simulated upload failure; no cloud API invoked")
            return original_run(command, **kwargs)
        with patch.object(operations, "run", side_effect=fail_upload):
            try:
                backup(source, failed_uploads, stop_after=True,
                       gcs_prefix="gs://disposable-test-bucket/daily", remove_local=True)
            except RuntimeError:
                pass
            else:
                raise AssertionError("Failed upload unexpectedly succeeded")
        assert list(failed_uploads.glob("*.tar.gz"))
        assert set(source.services()) == {"database", "traccar", "private-api-proxy"}
        passed("Stubbed GCS failure preserves local backup and resumes real Docker stack")
        successful_uploads = directory / "successful-upload"
        upload_commands = []
        def accept_upload(command, **kwargs):
            if command[0] == "gcloud":
                assert command[1:3] == ["storage", "cp"]
                assert "--if-generation-match=0" in command
                upload_commands.append(command)
                return b""
            return original_run(command, **kwargs)
        with patch.object(operations, "run", side_effect=accept_upload):
            backup(source, successful_uploads, gcs_prefix="gs://disposable-test-bucket/daily",
                   remove_local=True)
        assert len(upload_commands) == 2
        assert not list(successful_uploads.glob("*.tar.gz"))
        assert list(successful_uploads.glob("*.upload.json"))
        passed("Stubbed GCS success removes uploaded local archive/checksum; receipt retained")
        archive = backup(source, directory / "backups", stop_after=True)
        assert not source.services()
        passed("Protected database + configuration backup; cutoff stops containers preserving volumes")
        restored = directory / "restored"
        unpack(archive, restored)
        passed("Archive/database SHA256 verification and protected extraction")
        target.compose("up", "-d", "--wait", "--wait-timeout", "300", "database")
        restore(target, restored)
        try:
            restore(target, restored)
        except ValueError:
            passed("Restore refuses nonempty destination database")
        else:
            raise AssertionError("Nonempty restore not rejected")
        target.compose("up", "-d", "--wait", "--wait-timeout", "600")
        api = client(target)
        assert api.request("POST", "/api/session", login, True)[0] == 200
        assert any(d["id"] == device["id"] for d in api.request("GET", "/api/devices")[1])
        assert any(p["id"] == position_id for p in api.request("GET", "/api/positions")[1])
        passed("Fresh-volume restore: authenticated account/device/position recovered")
        for cid in target.compose("ps", "-q").decode().split():
            state = json.loads(run(["docker", "inspect", "--format", "{{json .State}}", cid]))
            assert not state["OOMKilled"]
        passed("Source and recovered containers have no OOM kill")
        summary["status"] = "passed"
    except Exception as error:
        summary["failure_type"] = type(error).__name__
        (directory / "failure.log").write_text(traceback.format_exc())
        # Save raw diagnostics privately; only sanitized summary is suitable for sharing.
        for stack in stacks:
            try:
                (directory / f"{stack.project}.log").write_bytes(stack.compose("logs", "--no-color"))
            except Exception:
                pass
        print(f"FAIL {type(error).__name__}; private diagnostics retained", flush=True)
    finally:
        for stack in stacks:
            try:
                # Names created by this invocation, never prune or down a user project.
                assert stack.project in summary["projects"] and stack.project.startswith("traccar-smoke-")
                stack.compose("down", "--volumes", "--remove-orphans")
                remaining = run(["docker", "volume", "ls", "-q", "--filter",
                                 f"label=com.docker.compose.project={stack.project}"])
                assert not remaining.strip()
                summary["cleanup"].append(f"{stack.project}: scoped containers/network/volumes removed")
            except Exception as error:
                summary["cleanup"].append(f"{stack.project}: FAILED {type(error).__name__}")
                summary["status"] = "failed"
        summary["finished_utc"] = dt.datetime.now(dt.timezone.utc).isoformat()
        (directory / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        if summary["status"] == "passed":
            # Exact mkdtemp directory created above; preserve only its shareable report.
            for child in directory.iterdir():
                if child.name == "summary.json":
                    continue
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
                else:
                    child.unlink()
        print(f"Summary: {directory / 'summary.json'}", flush=True)
    if summary["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
