# Singapore deployment preparation

Run commands from the API repository. This folder owns infrastructure and runtime
deployment; the shared `../../../docs/architecture/` folder records decisions and status.

`prepare.mjs` is scoped to project `traccar-510507` and its existing billing account.
It uses the active authenticated Google Cloud CLI, or `GCLOUD_BIN` when explicitly set.

```sh
node deploy/gcp/prepare.mjs --plan
node deploy/gcp/prepare.mjs --apply-secrets
node deploy/gcp/prepare.mjs --apply-infrastructure
node deploy/gcp/prepare.mjs --apply-private-tls
node deploy/gcp/prepare-backups.mjs
```

Apply modes change the named GCP resources and require owner authorization. The current
owner requested preparation and implementation on 2026-10-08. Keep operation within
US$150 planned spending and the 2026-12-20 export/stop date; do not upgrade billing.
The estimate is conditional on measured usage, rather than a spending guarantee.

Secrets are read using dotenv from the existing API `.env`; the current publishable
key is in ignored `setup.local.env`. Secret payloads travel to Secret Manager via
stdin and never appear in shell arguments or the output. Existing enabled versions
are reused when their exact contents match. The helper supports the existing legacy
service-role key through the API's backward-compatible configuration. Replace it with
a current Supabase secret key before its provider deprecation; the planned cutoff is
earlier than that transition. JWT signing material remains a separate secret.

The helper downloads the Supabase CA from its public certificate distribution URL
and verifies the pinned root identity before storing it. Database connections still
require certificate and hostname verification; never bypass that check.

The private Traccar endpoint uses a locally generated private CA and an IP SAN for
`10.60.0.10`. Only the CA certificate goes to the API; its private key stays in the
ignored `.local/private-tls` folder. The server leaf certificate/key goes to the VM's
root-owned configuration. Export this folder securely for recovery and renew the
90-day server certificate if the operating window changes.

The separate custom VPC has a `/28` VM subnet and a `/26` Cloud Run subnet. Only the
verified device port is public. SSH is restricted to IAP; HTTPS integration is allowed
only from the Cloud Run subnet. No default-VPC firewall is edited. Service identities
receive access only to the required secrets or backup bucket, not project-wide Editor.

The US$150 custom-period budget sends 50%, 75%, 90%, and 100% alerts to the billing
account's default IAM recipients. It excludes credits so the trial promotion cannot
hide resource usage. This conservatively includes charges the free tier might offset.
Alerts do not stop resources or guarantee the reserve.

Preparation creates no VM or Cloud Run service. Runtime release follows the tested
Traccar stack and API scripts in the component folders. Preserve local build/test and
database schema-check evidence, image digests, secret versions, and cloud readiness
in the shared deployment record. Do not run migrations solely to deploy an API whose
mapped tables/columns already exist; `synchronize` remains disabled.

Generated `.local` artifacts and environment files are ignored by Git and the Docker
build context. Do not print them, add them to source control, or copy secrets into
shared docs.

## Actual runtime release

The October 8 deployment is recorded in shared
[`docs/architecture/gcp-release-status.md`](../../../docs/architecture/gcp-release-status.md).
Preparation helpers alone do not deploy; `provision-vm.mjs --create` and
`release-api.mjs --deploy` perform the separately owner-authorized runtime changes.
Cloud Run uses gen1/concurrency one because its NGINX container has fractional CPU.

The VM stack is at `/opt/superkalan-traccar`, installed using `traccar/scripts/install-vm.sh`.
Use IAP SSH/OS Login; do not open public SSH or Traccar web ports. The protected local
`vm-bundle/operator.json` holds generated operator credentials; the signing CA stays
in `.local/private-tls`. Keep both in owner-controlled secure recovery storage.
`initialize-traccar.py` runs on the fresh VM and disables registration, creates a
non-admin integration account and writes a protected token. Then:

```sh
node deploy/gcp/connect-traccar.mjs
node deploy/gcp/release-api.mjs --deploy
node deploy/gcp/verify-private-path.mjs
```

The token importer captures only the fresh VM token over IAP, sends it to Secret Manager
through stdin and never prints it. The verifier creates and deletes a temporary read-only
Cloud Run job using the same network/CA/token; no devices or positions are written.

The backup uploader custom role has object create/get/list only on the named bucket,
not object delete. Gcloud needs destination metadata/listing for uploads. Daily archive
and checksum uploads use generation-zero preconditions. The systemd backup timer
briefly interrupts middleware while creating a consistent dump; the cutoff exports to
`final/` before disabling the stack. A separate timer shuts down the VM one hour later.
This does not release disk/IP or stop Cloud Run; review retained resources at cutoff.

To repeat recovery using an owner-authenticated, downloaded archive and matching checksum:

```sh
python3 deploy/gcp/traccar/scripts/cloud-restore-drill.py \
  deploy/gcp/.local/cloud-backup/ARCHIVE.tar.gz \
  deploy/gcp/.local/vm-bundle/operator.json
```

It restores only into newly generated disposable local Docker volumes, verifies the
real cloud accounts/policy/TLS, then removes those test volumes. Never run volume cleanup
against the production Compose project. Backups contain secrets; keep downloads protected.
