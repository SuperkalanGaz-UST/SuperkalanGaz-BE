# Cloud Run API deployment

Manual local preparation for the existing NestJS API, with NGINX as the only
Cloud Run ingress container. Run commands from the API repository root. This
folder does not provision networks, databases, billing, or secret payloads.

## Local verification

    node --test deploy/gcp/api/deployment.test.mjs
    node --check deploy/gcp/api/render-service.mjs
    bash -n deploy/gcp/api/build-push.sh deploy/gcp/api/deploy-service.sh

The standalone tests parse the rendered YAML with the repository's installed
`js-yaml` dependency and run the helper against a fake gcloud executable.
They never contact GCP, read local env files, or read secret payloads.

## Required rendering and deployment variables

Export these resource references and public settings in the invoking shell.
The renderer intentionally does not source `.env` or `setup.local.env`.

    export GCP_PROJECT_ID=traccar-510507
    export GCP_VPC_NETWORK=superkalan-vpc
    export GCP_VPC_SUBNET=superkalan-run-sg
    export GCP_RUNTIME_SERVICE_ACCOUNT=YOUR_RUNTIME_SA_EMAIL
    export SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
    export SUPABASE_PUBLISHABLE_KEY=YOUR_CURRENT_PUBLISHABLE_KEY
    export DATABASE_SECRET_NAME=superkalan-database-url
    export DATABASE_SECRET_VERSION=1
    export SUPABASE_SECRET_KEY_SECRET_NAME=superkalan-supabase-secret-key
    export SUPABASE_SECRET_KEY_SECRET_VERSION=1
    export SUPABASE_DB_CA_SECRET_NAME=superkalan-supabase-db-ca
    export SUPABASE_DB_CA_SECRET_VERSION=1
    export API_IMAGE=asia-southeast1-docker.pkg.dev/traccar-510507/superkalan-crm/api@sha256:YOUR_64_HEX_DIGEST
    export NGINX_IMAGE=asia-southeast1-docker.pkg.dev/traccar-510507/superkalan-crm/api-nginx@sha256:YOUR_64_HEX_DIGEST

`GCP_ARTIFACT_REPOSITORY` defaults to `superkalan-crm`; if supplied, both images
must belong to that repository. Images must be pinned by digest in the selected
project and Singapore registry. `API_WEB_ORIGIN` optionally supplies comma-separated
exact origins; its default is `http://localhost:3000` for the local dashboard.
Set the selected web host's exact HTTPS origin when available. Governance invitation
links use the first origin, and Delivery Rider invitation links fall back to that
origin plus `/delivery-rider-invitation`; do not claim hosted invitations work while
that origin is localhost. Web/mobile hosting is separate work.

The network annotation always includes `"tags": ["superkalan-api"]`. Main prepares
the approved subnet `10.60.1.0/26` and the firewall path to private Traccar
`10.60.0.10:443`. Direct VPC uses `private-ranges-only` egress, leaving public
Supabase traffic on Cloud Run's ordinary internet path without requiring Cloud NAT.

## Supabase keys and legacy session verification

The secret named by `SUPABASE_SECRET_KEY_SECRET_NAME` maps to the runtime
`SUPABASE_SECRET_KEY` environment variable. Its payload may be the verified legacy
`service_role` JWT or a current `sb_secret_...` key: the existing server-side
header helper supports both. With the legacy JWT it sends both `apikey` and
Bearer authorization; with current keys it sends only `apikey`. Do not duplicate
the legacy key under another runtime variable or put its value in a manifest.

For this project's legacy HS256 sessions, also export:

    export SUPABASE_JWT_SECRET_SECRET_NAME=superkalan-supabase-jwt-secret
    export SUPABASE_JWT_SECRET_SECRET_VERSION=1

These two references are optional as a pair in the renderer, but required for
the existing API to verify HS256 access tokens. The API can start without them,
so successful health checks do not prove authentication works. ES256/RS256
verification uses the project's JWKS endpoint and does not require the shared
secret. A publishable API key does not change the session-signing algorithm.
Keep the secret reference until signing-key migration and expiration of older
sessions are verified. See [Supabase signing keys](https://supabase.com/docs/guides/auth/signing-keys)
and [API key types](https://supabase.com/docs/guides/getting-started/api-keys).

Main owns secret creation/upload: use existing Singapore-replicated resources,
pinned numeric versions, hidden input or a protected stream to
`gcloud secrets versions add --data-file=-`. Never echo payloads, put them on
command-line arguments, enable shell tracing, or print either local env file.
The deployment helper describes version metadata only; it never runs
`secrets versions access`.

Production Postgres requires `DATABASE_URL`, verified TLS, and the Supabase CA
certificate. The template mounts that CA at
`/var/run/secrets/supabase/root.crt`, with explicit 0444 permissions so the
non-root Node process can read the root-owned secret mount. Main must verify the
target database schema/migration state separately; the helpers do not run migrations.
If all entity columns match and no migration is being applied, record the verified
schema fingerprint; adopting a new SQL runner is not a prerequisite for this release.
Do not use the existing one-off migration runner or enable TypeORM synchronize.

## Optional private Traccar integration

CA trust can be staged independently for the API smoke test:

    export TRACCAR_CA_SECRET_NAME=superkalan-traccar-ca
    export TRACCAR_CA_SECRET_VERSION=1

This mounts the private CA and sets NODE_EXTRA_CA_CERTS even before Traccar calls
are enabled. Token name/version references can also be staged as a pair. To enable
the existing device-provisioning integration, export all five:

    export TRACCAR_BASE_URL=https://10.60.0.10
    export TRACCAR_TOKEN_SECRET_NAME=YOUR_TRACCAR_TOKEN_SECRET
    export TRACCAR_TOKEN_SECRET_VERSION=YOUR_NUMERIC_VERSION
    export TRACCAR_CA_SECRET_NAME=YOUR_TRACCAR_CA_SECRET
    export TRACCAR_CA_SECRET_VERSION=YOUR_NUMERIC_VERSION

The renderer rejects incomplete name/version pairs and requires both token and
CA references when TRACCAR_BASE_URL is set. It rejects public endpoints, plain
HTTP, and nonstandard ports. It maps the token via Secret Manager to `TRACCAR_TOKEN`,
mounts the CA at `/var/run/secrets/traccar/root.crt` with 0444 permissions, and
sets `NODE_EXTRA_CA_CERTS` to that path before Node starts. The CA secret contains
trusted PEM certificates, never a private key. The VM's leaf certificate must
include IP SAN `10.60.0.10`; a trusted CA alone does not fix a name mismatch.
Never disable TLS verification.

[Node reads NODE_EXTRA_CA_CERTS at process startup](https://nodejs.org/api/cli.html#node_extra_ca_certsfile).
It extends default HTTPS trust, including the existing Traccar fetch client;
it does not replace the explicit PostgreSQL CA setting. Redeploy/restart for a CA
rotation. The template uses numbered versions to keep release trust reproducible.
This configuration adds no polling or new Fleet behavior. If the endpoint is unset, the API starts
but Traccar-dependent vehicle provisioning is unavailable.

## Probes, billing, and capacity

NGINX and API startup probes both call `/api/health/ready`, through ports 8080
and 3001 respectively, using a 240-second retry window and a 10-second timeout.
The dependency annotation starts NGINX after the API passes startup. The NGINX
check verifies the proxy-to-API path; the readiness handler checks PostgreSQL.
The API's recurring liveness probe calls `/api/health/live` and checks process
health without making a database query. No recurring DB readiness probe is added.

The [current service health-check documentation](https://docs.cloud.google.com/run/docs/configuring/healthchecks)
allocates CPU during probes and bills probe CPU/memory, without a request charge.
The template retains [request-based billing](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
(`cpu-throttling: true`), min instances 0, revision max instances 2, concurrency 1,
and a 60-second request timeout. Include probes in the funded-window estimate;
request-based CPU is unsuitable for a dependable in-process periodic poller.

Per active instance the existing allocation is API 1 vCPU/1 GiB plus NGINX
0.5 vCPU/256 MiB, matching the fractional NGINX allocation in Google's
[frontend proxy example](https://docs.cloud.google.com/run/docs/internet-proxy-nginx-sidecar).
The [CPU guide's fractional-CPU constraints](https://docs.cloud.google.com/run/docs/configuring/services/cpu)
require concurrency 1, request-based billing, and the first generation execution
environment. The manifest explicitly selects gen1 and concurrency 1 to comply;
CPU allocation stays at 1.5 vCPU total, without raising the resource budget.
Google [supports multi-container services in either generation](https://docs.cloud.google.com/run/docs/deploying#deploying-multiple-containers-to-a-service).
Its NGINX example alone does not validate our former concurrency 20 setting.
Actual billed duration and throughput still require measurement after lowering concurrency.
The TypeORM pool is fixed at 5 per instance, so two instances target 10 database
connections in steady state. Revision overlap and temporary scaling overshoot
require margin within the reported 60-connection limit, plus other clients.
These are starting limits to measure, not a hard connection/spending cap.

## Main's release sequence

1. Complete the authorized network/firewall, runtime identity, secret, budget,
   database/schema and private TLS work. Keep the free-credit ceiling, reserve,
   alerts, and 2026-12-20 export/stop cutoff. Existing approval variables reflect
   the authorized decision; stale local records do not create a new approval gate.
2. Create/verify the Singapore Artifact Registry repository, then use
   `CREDIT_GATE_APPROVED=YES GCP_PROJECT_ID=traccar-510507 API_IMAGE_TAG=YOUR_UNIQUE_TAG ./deploy/gcp/api/build-push.sh`.
   Its typed BUILD confirmation authorizes two linux/amd64 image pushes. Resolve
   both immutable digests and export the image variables above.
3. Render locally with
   `node deploy/gcp/api/render-service.mjs deploy/gcp/api/service.yaml.tmpl > deploy/gcp/api/service.rendered.yaml`.
   Review it without secret payloads. The output file is ignored by Git.
4. Reflect the approved cost/release decision with `CREDIT_GATE_APPROVED=YES`
   and `RELEASE_APPROVED=YES`, then invoke `./deploy/gcp/api/deploy-service.sh`.
   It validates inputs locally, checks the active project, image existence,
   runtime identity, ENABLED secret versions and subnet/network membership.
   Only after typed DEPLOY does it grant secret-specific accessor permissions and
   replace the service. No project-wide secret access or network creation occurs.
5. Smoke-test the public HTTPS URL through NGINX: live/ready routes, valid session,
   unauthenticated rejection, branch isolation and configured CORS. Test private
   Traccar TLS/authentication independently. Keep image digests, secret versions
   and a healthy prior revision for rollback. The accepted Beta multi-container
   feature and real cloud runtime remain part of main's release verification.

This local-preparation task does not itself push images, deploy Cloud Run, or
certify live integrations. Billing alerts and revision instance limits do not
enforce the whole deployment's funding ceiling or stop Compute Engine costs.
