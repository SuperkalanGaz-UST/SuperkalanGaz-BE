# Local verification — 2026-10-08

The pinned Linux AMD64 smoke/restore run passed all 11 checks. Evidence:
[sanitized summary](.runtime/smoke-v2czael0/summary.json).

- MySQL authenticated readiness, Traccar's actual `wget /api/health` check, and NGINX healthy.
- Private-CA TLS with SAN IP 10.60.0.10 succeeds; wrong CA/IP rejected.
- First administrator creation/login and authenticated device provisioning succeed.
- Anonymous device access rejected; persisted `registration=false` blocks anonymous signup.
- Synthetic H02/TCP 5013 position ingested, preserved across restart, and recovered.
- Database/config archive and checksums verified; restore into new volumes succeeds.
- Nonempty destination refused; both test projects' containers/network/volumes removed.

Tested AMD64 manifests (also in Compose and .env.example):

| Image | Digest |
| --- | --- |
| traccar/traccar:6.16.0 | sha256:a32a4e0a0656a3fc9ba0b23e9e741be2fab76d85c5208b6adfeef7ab473979e8 |
| mysql:8.4 (8.4.11) | sha256:80f4933e3835f9dc4d35a28ec500d7986cb4414e6c6821c5461239cb7beb8995 |
| nginx:1.30.5-alpine3.24 | sha256:8f84ed99befc3891b8f329c5c202785278a2cfb7c25107d57fb2a134a3117433 |

Snapshot: MySQL 256.3 MiB, Traccar 381.6 MiB, NGINX 59.09 MiB. Limits total
1,472 MiB; source containers had no OOM kill. Docker Desktop ARM64 emulates AMD64;
these measurements do not establish actual e2-small/device-load capacity.

Subsequent supplemental checks passed startup/auth/H02/restart with the one-worker
NGINX configuration. Using real disposable Docker containers and stubbed cloud calls,
GCS failure preserved local backup and resumed service, and GCS success removed only
uploaded local archives/checksums while retaining a receipt. The supplemental run
was stopped at the user's request; it is not another completed full restore report.

Python compilation, shell syntax and Git whitespace checks pass. OpenSSL's CA serial
path is now explicitly inside the protected test directory; its own stray .srl was removed.
No cloud calls were made by this deployment-preparation work. Real GCS upload/IAM,
VM systemd execution, private VPC path, physical tracker traffic, and production
administrator/integration-token provisioning remain main's live deployment checks.

Bootstrap contract is documented in README.md: /opt/superkalan-traccar, root-owned
.env and certs/, metadata identity, daily/ uploads, final/ exports at midnight PH
on 2026-12-20, and main's separate 01:00 PH VM-shutdown fallback.

## Main's actual cloud checks — 2026-10-08

The fresh Singapore VM runs all three containers healthy. First administrator and
non-admin integration account/token are initialized; registration is disabled.
Cloud Run's temporary read-only job verifies private VPC, correct CA/IP SAN,
anonymous HTTP 401 and authenticated HTTP 200. Public port 5013 is reachable;
22/443/8082/3306/3389 are not publicly reachable.

The first real upload revealed that gcloud needs object get/list in addition to create.
The final bucket-scoped custom role grants those three permissions and no delete.
Systemd backup now reports success; generation-zero upload preconditions remain.

Downloaded archive `superkalan-traccar-20261008T051517347677Z.tar.gz` and checksum
restore successfully through `scripts/cloud-restore-drill.py`: checksums, fresh-volume
SQL import, verified TLS, operator login, non-admin integration identity, disabled
registration and empty device list all pass. The generated local recovery project
and volumes were removed; production data was not changed or removed.
Actual physical ST-901/SIM traffic and sustained-load capacity remain unverified.
