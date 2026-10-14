#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "${CREDIT_GATE_APPROVED:-}" != "YES" ]]; then
  echo "Stop: the free-credit and full-runtime cost gate has not been approved." >&2
  exit 1
fi
if [[ "${RELEASE_APPROVED:-}" != "YES" ]]; then
  echo "Stop: set RELEASE_APPROVED=YES only for an owner-approved manual release." >&2
  exit 1
fi

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID explicitly}"
: "${GCP_VPC_NETWORK:?Set the approved Direct VPC network name}"
: "${GCP_VPC_SUBNET:?Set the approved asia-southeast1 subnet name}"
: "${GCP_RUNTIME_SERVICE_ACCOUNT:?Set the least-privilege Cloud Run service account email}"
: "${SUPABASE_URL:?Set the existing Supabase project HTTPS URL}"
: "${SUPABASE_PUBLISHABLE_KEY:?Set the current Supabase publishable key}"
: "${API_IMAGE:?Set the immutable API Artifact Registry image URI ending in @sha256:<digest>}"
: "${NGINX_IMAGE:?Set the immutable NGINX Artifact Registry image URI ending in @sha256:<digest>}"
: "${DATABASE_SECRET_NAME:?Set the Secret Manager secret containing DATABASE_URL}"
: "${DATABASE_SECRET_VERSION:?Set a numeric DATABASE_URL secret version}"
: "${SUPABASE_SECRET_KEY_SECRET_NAME:?Set the Secret Manager secret containing SUPABASE_SECRET_KEY}"
: "${SUPABASE_SECRET_KEY_SECRET_VERSION:?Set a numeric Supabase secret-key version}"
: "${SUPABASE_DB_CA_SECRET_NAME:?Set the Secret Manager Supabase CA secret name}"
: "${SUPABASE_DB_CA_SECRET_VERSION:?Set a numeric Supabase CA secret version}"

region="asia-southeast1"
repository="${GCP_ARTIFACT_REPOSITORY:-superkalan-crm}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for command_name in gcloud node; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command not found: ${command_name}" >&2
    exit 1
  fi
done

# Validate every input locally before querying GCP. Only resource references,
# the publishable key and public settings enter the rendered manifest.
export GCP_PROJECT_ID GCP_VPC_NETWORK GCP_VPC_SUBNET GCP_RUNTIME_SERVICE_ACCOUNT
export SUPABASE_URL SUPABASE_PUBLISHABLE_KEY API_IMAGE NGINX_IMAGE DATABASE_SECRET_NAME DATABASE_SECRET_VERSION
export SUPABASE_SECRET_KEY_SECRET_NAME SUPABASE_SECRET_KEY_SECRET_VERSION
export SUPABASE_DB_CA_SECRET_NAME SUPABASE_DB_CA_SECRET_VERSION
render_dir="$(mktemp -d "${TMPDIR:-/tmp}/superkalan-api-service.XXXXXX")"
rendered_service="${render_dir}/service.yaml"
trap 'rm -f "${rendered_service}"; rmdir "${render_dir}"' EXIT
node "${script_dir}/render-service.mjs" "${script_dir}/service.yaml.tmpl" > "${rendered_service}"
secret_refs="$(node "${script_dir}/render-service.mjs" --secret-refs)"

active_project="$(gcloud config get-value project 2>/dev/null)"
if [[ "${active_project}" != "${GCP_PROJECT_ID}" ]]; then
  echo "Active gcloud project is '${active_project}', not '${GCP_PROJECT_ID}'." >&2
  exit 1
fi

runtime_account_project="${GCP_RUNTIME_SERVICE_ACCOUNT#*@}"
if [[ "${runtime_account_project}" != "${GCP_PROJECT_ID}.iam.gserviceaccount.com" ]]; then
  echo "Runtime service account must belong to ${GCP_PROJECT_ID}." >&2
  exit 1
fi

gcloud artifacts repositories describe "${repository}" --location="${region}" --project="${GCP_PROJECT_ID}" >/dev/null
gcloud artifacts docker images describe "${API_IMAGE}" --project="${GCP_PROJECT_ID}" >/dev/null
gcloud artifacts docker images describe "${NGINX_IMAGE}" --project="${GCP_PROJECT_ID}" >/dev/null
gcloud iam service-accounts describe "${GCP_RUNTIME_SERVICE_ACCOUNT}" --project="${GCP_PROJECT_ID}" >/dev/null
while IFS=$'\t' read -r secret_name secret_version; do
  secret_state="$(gcloud secrets versions describe "${secret_version}" --secret="${secret_name}" --project="${GCP_PROJECT_ID}" --format='value(state)')"
  if [[ "${secret_state}" != "ENABLED" ]]; then
    echo "Secret version ${secret_name}:${secret_version} must be ENABLED." >&2
    exit 1
  fi
done <<< "${secret_refs}"
subnet_network="$(gcloud compute networks subnets describe "${GCP_VPC_SUBNET}" --region="${region}" --project="${GCP_PROJECT_ID}" --format='value(network)')"
if [[ "${subnet_network}" != *"/networks/${GCP_VPC_NETWORK}" ]]; then
  echo "Subnet ${GCP_VPC_SUBNET} is not attached to network ${GCP_VPC_NETWORK}." >&2
  exit 1
fi

echo "This will publish the API at a public Cloud Run HTTPS URL in ${GCP_PROJECT_ID}."
echo "The API enforces caller JWT authorization. Billing stays request-based, min=0, max=2."
if [[ -n "${TRACCAR_BASE_URL:-}" ]]; then
  echo "Private Traccar HTTPS, token reference and CA mount are configured; verify TLS and firewall before release."
else
  echo "Traccar is unconfigured; vehicle provisioning remains unavailable."
fi
if [[ -z "${SUPABASE_JWT_SECRET_SECRET_NAME:-}" ]]; then
  echo "No legacy JWT secret reference configured: HS256 sessions will be rejected."
fi
echo "The NGINX + API multi-container feature is currently Beta."
read -r -p "Type DEPLOY to create/update the service: " approval
if [[ "${approval}" != "DEPLOY" ]]; then
  echo "Deployment cancelled."
  exit 0
fi

while IFS=$'\t' read -r secret_name secret_version; do
  gcloud secrets add-iam-policy-binding "${secret_name}" --member="serviceAccount:${GCP_RUNTIME_SERVICE_ACCOUNT}" --role="roles/secretmanager.secretAccessor" --project="${GCP_PROJECT_ID}" --quiet >/dev/null
done <<< "${secret_refs}"
gcloud run services replace "${rendered_service}" --project="${GCP_PROJECT_ID}" --region="${region}"
