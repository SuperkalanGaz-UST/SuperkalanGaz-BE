# Cloud Run API deployment

This is a manual release path for the existing NestJS API. No application
service is deployed until a release script is run; the preflight wizard can
create only the explicitly confirmed Secret Manager resources described below.

## Repeatable setup wizard

From the API repository root, run:

    ./deploy/gcp/setup-wizard.sh

The wizard performs read-only gcloud project/network discovery, asks you to
recheck trial credit, full-window estimate and reserve, records an export/stop
date before trial expiry, records the ST-901 port only as verified when you
confirm the physical unit/seller, and captures the existing Supabase project settings. It writes non-secret setup values to the
ignored `deploy/gcp/setup.local.env` file. It does **not** treat discovered
networks as approved deployment settings; the existing default VPC still needs
a separate security review.

After an explicit confirmation in the Supabase stage, the wizard can create
Secret Manager resources with user-managed replication in Singapore and upload the database URL, current
`sb_secret_...` key, and downloaded database CA certificate. Secret payloads
are entered hidden or read from the selected certificate file, sent directly to
Secret Manager, and never saved in the local config. On a rerun, it offers to
reuse exact recorded secret versions without reading their values. It does not
enable APIs automatically.

The wizard stops before VM, firewall, image, Artifact Registry, Cloud Run, or
deployment changes. Its cost result is a preflight record, not approval: review
the live estimate and reserve, the unresolved VPC/firewall and migration gates,
and the release checklist before separately authorizing a deployment. It does
not configure billing budget alerts; create and verify project-scoped alerts
after the final cost approval and before provisioning. Alerts are notifications,
not a hard stop for Compute Engine charges.

## Important deployment gates

- Check the real billing account credit balance and expiry; do not use the
  advertised trial amount as a substitute. Include the continuously running VM,
  disk, static IP, Artifact Registry, Cloud Run, VPC networking, logs, and backups
  in the estimate and keep a reserve. The scripts refuse to proceed unless
  CREDIT_GATE_APPROVED=YES is set and then ask for a typed confirmation.
- The Cloud Run NGINX + API multi-container feature is currently Beta. Review
  that status and accept it before deployment.
- Direct VPC egress requires an existing network and a subnet in
  asia-southeast1. The manifest requires those names; it does not guess a network.
- Add numbered Secret Manager versions for DATABASE_URL,
  SUPABASE_SECRET_KEY, and the Supabase database root CA certificate. Supabase
  is deprecating the legacy `service_role` key by the end of 2026; the API uses
  the current `sb_secret_...` format on the `apikey` header without treating it
  as a JWT. Keep `SUPABASE_PUBLISHABLE_KEY` as a non-secret runtime setting.
  The runtime identity receives accessor permission only on those three secrets.
- Private Traccar TLS is deliberately not enabled in the first API manifest.
  Select and test the certificate trust and private network path before adding
  TRACCAR_BASE_URL or TRACCAR_TOKEN.
- The current SQL files have no verified production migration ledger, and one
  migration drops an existing table. Do not deploy against the live Supabase
  project until the applied migration state and a reviewed one-time migration
  procedure are confirmed.

## Build and push

Create the Artifact Registry repository only after the approved cost gate:

    gcloud artifacts repositories create superkalan-crm --repository-format=docker --location=asia-southeast1 --project=YOUR_PROJECT_ID

Then build and push immutable-release candidates from the API repository:

    cd superkalan-crm-api
    CREDIT_GATE_APPROVED=YES GCP_PROJECT_ID=YOUR_PROJECT_ID API_IMAGE_TAG=YOUR_UNIQUE_TAG ./deploy/gcp/api/build-push.sh

The script builds for linux/amd64 and pushes both the API and NGINX images. Resolve
each tag to its SHA-256 digest and use the digest in the deployment environment.

## Prepare the runtime identity and secrets

Create a dedicated service account and the three Secret Manager secrets outside
the repository. Download the database CA certificate from the existing Supabase
project's Database Settings → SSL Configuration. Use the connection mode approved
for the API's Cloud Run scaling. Never place secret values in a checked-in file or
command history. The deploy script verifies the selected secret versions and
grants the runtime service account access only to those secrets after the typed
deployment confirmation.

## Deploy

Set the following values in the current shell. They are resource names, URLs,
numeric secret versions, and immutable image digests—not secret payloads:

    export GCP_PROJECT_ID=YOUR_PROJECT_ID
    export GCP_VPC_NETWORK=YOUR_NETWORK_NAME
    export GCP_VPC_SUBNET=YOUR_ASIA_SOUTHEAST1_SUBNET
    export GCP_RUNTIME_SERVICE_ACCOUNT=YOUR_RUNTIME_SA_EMAIL
    export SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
    export DATABASE_SECRET_NAME=YOUR_DATABASE_URL_SECRET
    export DATABASE_SECRET_VERSION=1
    export SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
    export SUPABASE_SECRET_KEY_SECRET_NAME=YOUR_SECRET_KEY_SECRET
    export SUPABASE_SECRET_KEY_SECRET_VERSION=1
    export SUPABASE_DB_CA_SECRET_NAME=YOUR_SUPABASE_CA_SECRET
    export SUPABASE_DB_CA_SECRET_VERSION=1
    export API_IMAGE=asia-southeast1-docker.pkg.dev/PROJECT/REPOSITORY/api@sha256:DIGEST
    export NGINX_IMAGE=asia-southeast1-docker.pkg.dev/PROJECT/REPOSITORY/api-nginx@sha256:DIGEST

Set CREDIT_GATE_APPROVED=YES and RELEASE_APPROVED=YES only after the cost review
and release checks are complete, then run:

    ./deploy/gcp/api/deploy-service.sh

It validates project, VPC/subnet, service account, secret versions, renders a
temporary service manifest, binds secret access at the individual-secret level,
and asks you to type DEPLOY before changing Cloud Run. The API port is not
publicly exposed; NGINX is the only ingress container. The Cloud Run URL is
public HTTPS, while NestJS continues to enforce caller JWT and branch scope.

The default web CORS origin is localhost for development clients. Once a web
host is chosen in its separate deployment work, redeploy with API_WEB_ORIGIN set
to its exact HTTPS origin. Delivery Rider invitation links likewise need the
web registration URL before that workflow is production-ready.
