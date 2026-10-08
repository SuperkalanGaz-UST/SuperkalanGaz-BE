# Traccar deployment and recovery

This directory prepares SinoTrack ST-901 → Traccar middleware. It provisions no cloud
resources, builds no CRM API image, and migrates no Windows data. Physical tracker,
firewall, VPC and VM capacity checks remain release gates.

## Disposable local test

From the API repository:

```sh
python3 deploy/gcp/traccar/scripts/smoke.py
```

Requires Docker, Compose 2.24.4+ (test uses `!override`), Python 3.9+, OpenSSL and
Linux AMD64 execution support. On Apple Silicon these images run under emulation;
timing/CPU/memory results do not certify e2-small capacity.

The test uses production Compose plus loopback-only ephemeral ports, generated
credentials, disposable private-CA TLS with IP SAN 10.60.0.10, and two unique projects.
It checks actual health, TLS trust/IP rejection, anonymous API rejection, first-admin
registration/login, registration hardening, device provisioning, synthetic H02 ingestion,
restart persistence, backup/checksums, fresh-volume restore, and nonempty-restore refusal.
A synthetic packet is not evidence of a physical tracker or cellular connection.

Ignored `.runtime/smoke-*/summary.json` records results. Failure diagnostics and test
credentials are protected in that folder; do not print raw logs, env files or archives.
Successful runs remove disposable credentials/backups and preserve the summary.
Cleanup removes only those exact test projects/volumes, preserving shared images and
user resources. The test never reads a developer .env or invokes cloud APIs.

## Main VM bootstrap contract

Target: e2-small, 30 GB disk, Ubuntu 24.04, asia-southeast1-b, private IP 10.60.0.10.
Main configures budget alerts/credit gate before provisioning. Copy this directory's
tracked files to `/opt/superkalan-traccar`, preserving scripts/, systemd/ and nginx/.
Exclude .runtime/, backups/ and disposable certs.

Main supplies:

- Docker Engine/Compose plugin, Python 3, OpenSSL, flock (util-linux), Google Cloud CLI.
- Root-owned `.env` (600), based on .env.example, with distinct generated DB passwords.
- `certs/traccar-api.crt`, `certs/traccar-api.key` (600), `certs/ca.crt`.
  Leaf SAN must be IP:10.60.0.10, key must match, and leaf must chain to the private CA.
  Main generates/distributes these; never place the CA private key on the VM.
  NestJS trusts the CA public certificate and calls https://10.60.0.10 with verification.
- `backup.env` (600) containing only
  BACKUP_GCS_PREFIX=gs://superkalan-traccar-backups-traccar-510507/daily.
  Main creates a private Singapore bucket with uniform access, public access prevention,
  seven-day lifecycle deletion scoped only to daily/, seven-day recoverable soft deletion,
  and no hard retention lock. final/ is excluded from lifecycle deletion. VM identity needs bucket-scoped
  bucket-scoped `superkalanBackupUploader` (object create/get/list, no delete) and
  an OAuth access scope permitting storage reads/writes.
  Use metadata identity; no service-account key file.
- Cloud/host firewall: approved H02/TCP 5013 ingress, private 443 only from the approved
  Cloud Run VPC path, restricted IAP/OS Login administration. No host MySQL 3306 or raw
  Traccar 8082 binding. NGINX binds only 10.60.0.10.

On the VM:

```sh
cd /opt/superkalan-traccar
sudo bash scripts/install-vm.sh --install
sudo systemctl start superkalan-traccar-backup.service
```

Installer validates prerequisites/TLS and installs stack/backup/cutoff systemd units.
It refuses startup after cutoff. It does not install packages, generate credentials,
change firewalls or provision cloud resources. Validate Compose without exposing
expanded secrets: `docker compose --env-file .env config --quiet`.

## First administrator and registration

Keep the empty server administratively isolated. Main creates the first middleware
administrator via IAP-restricted POST /api/users using protected request files, then
authenticates with form-encoded POST /api/session. Never print passwords/cookies.
This is middleware administration, not a CRM role or a public CRM signup flow.

In Traccar 6.16.0, registration is the persisted server field `registration`; there
is no documented `web.register` configuration key. Authenticated GET /api/server,
preserve its fields, set registration=false, then authenticated PUT /api/server.
Verify a new anonymous POST /api/users is rejected. Main provisions the dedicated
NestJS integration account/token and Secret Manager wiring. The empty-database
first-admin exception remains, so isolate bootstrap even with registration disabled.
Sources: [UserResource](https://github.com/traccar/traccar/blob/v6.16.0/src/main/java/org/traccar/api/resource/UserResource.java),
[ServerResource](https://github.com/traccar/traccar/blob/v6.16.0/src/main/java/org/traccar/api/resource/ServerResource.java).

## Memory and persistence

Limits total 1,472 MiB: MySQL 640, Traccar 768, NGINX 64. MySQL uses a 128 MiB buffer
pool, 30 connections, performance schema off. Java heap is capped at 384 MiB, direct
memory at 128 MiB, effective processors at two, and database pool at five.
Measure real VM host headroom, OOM state, disk and actual reporting load before release.
The local drill stops the source before starting the restore stack.

mysql_data and traccar_logs are persistent project-scoped volumes. Docker JSON logs
rotate at 10 MB × 3 per container; application logs and position-history retention
still require the actual operational policy. Monitor the 30 GB disk. Never use
down --volumes on the VM stack. Editing DB passwords in .env does not rotate credentials
inside an already initialized MySQL volume.

## Backup, GCS upload and cutoff

Daily backup runs at 18:00 UTC with up to five minutes jitter and flock serialization.
It briefly stops the proxy/Traccar to quiesce writers, runs a transactional streaming
mysqldump, then resumes previously running writers. MySQL stays running. Expect a
short device/API interruption.

The archive contains compressed SQL, checksum manifest, original/effective Compose,
.env, NGINX config and TLS leaf/key: it contains secrets. Staging/directories are 700,
files 600. Upload uses unique timestamp names and --if-generation-match=0, sends the
archive and checksum, and removes those exact local files only after both uploads pass.
A protected nonsensitive upload receipt remains. Failure preserves local backup,
resumes service and fails the systemd job; main must monitor backup failures/freshness.

No extra encryption key: GCS default encryption at rest and HTTPS uploads are used.
Local archives are compressed, not independently encrypted, and rely on filesystem
permissions and VM disk encryption. The uploader can create/get/list only this bucket's
objects (gcloud needs destination metadata/listing), but cannot delete/overwrite;
main needs a separate authorized reader for an off-VM download/restore drill.
Real GCS IAM, metadata authentication and upload are not tested by this local task.
Sources: [GCS encryption](https://docs.cloud.google.com/storage/docs/encryption/default-keys),
[Object Creator](https://docs.cloud.google.com/storage/docs/access-control/iam-roles),
[gcloud storage cp](https://docs.cloud.google.com/sdk/gcloud/reference/storage/cp).

Local backup without cloud upload:

```sh
python3 scripts/operations.py --project superkalan-traccar --env-file .env \
  backup --output /opt/superkalan-traccar/backups
```

Persistent cutoff: 2026-12-19 16:00 UTC = 2026-12-20 00:00 Asia/Manila. Final export/upload
precedes container stop and disabling stack/daily-backup startup; named volumes remain.
The cutoff helper rewrites the configured daily/ prefix to final/ in the same bucket.
Main's VM bootstrap adds an independent shutdown fallback at 01:00 Asia/Manila, giving
the midnight export one hour to complete. That fallback is managed outside this folder.
Export/upload failure resumes service and requires operator recovery. This is not a
hard spend cap. Main must stop the GCE VM and review disk/static-IP/backup costs
separately. Final exports remain outside the daily lifecycle; preserve a verified
off-cloud copy before trial/account access ends. No cloud-resource deletion is implemented.

## Restore an empty destination

Download archive plus matching .sha256 using a separate reader. Preserve original
VM volumes. Use the same image digests and a new project. Unpack validates checksums,
refuses an existing destination, and accepts only known regular files/directories.
Review recovered config privately, install TLS at the new paths, and remap paths/IP/ports.
Do not blindly start compose.resolved.json; it records the original host paths.

```sh
python3 scripts/operations.py --project traccar-recovery --env-file recovery.env \
  unpack --archive /protected/backup.tar.gz --destination /protected/recovered
docker compose --env-file recovery.env -p traccar-recovery up -d --wait database
python3 scripts/operations.py --project traccar-recovery --env-file recovery.env \
  restore-empty --directory /protected/recovered
docker compose --env-file recovery.env -p traccar-recovery --profile private-api up -d --wait
```

recovery.env must be 600. Restore requires only the destination database running and
zero tables; it never drops or replaces a populated database. Verify recovered login,
devices, positions and TLS before a deployment change.

## Images and release verification

Starting tags were available on 2026-10-08: Traccar 6.16.0, MySQL 8.4 (resolved 8.4.11),
NGINX 1.30.5-alpine3.24. Record the sanitized test summary and tested AMD64 digest pins;
rerun after image/config/helper changes. [Official Traccar Docker guidance](https://www.traccar.org/docker/)
recommends MySQL for smaller non-testing deployments and publishing required ports only.
