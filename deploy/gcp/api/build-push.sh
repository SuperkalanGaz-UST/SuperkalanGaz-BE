#!/usr/bin/env bash
set -euo pipefail

if [[ "${CREDIT_GATE_APPROVED:-}" != "YES" ]]; then
  echo "Stop: review the actual credit balance/expiry and full estimate first." >&2
  echo "Set CREDIT_GATE_APPROVED=YES only after the approved cost gate is satisfied." >&2
  exit 1
fi

: "${GCP_PROJECT_ID:?Set GCP_PROJECT_ID explicitly}"
: "${API_IMAGE_TAG:?Set a unique API_IMAGE_TAG for this manual release}"
if [[ ! "${API_IMAGE_TAG}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "API_IMAGE_TAG contains characters not allowed by Docker." >&2
  exit 1
fi

region="asia-southeast1"
repository="${GCP_ARTIFACT_REPOSITORY:-superkalan-crm}"
registry="${region}-docker.pkg.dev/${GCP_PROJECT_ID}/${repository}"
api_image="${registry}/api:${API_IMAGE_TAG}"
nginx_image="${registry}/api-nginx:${API_IMAGE_TAG}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
api_root="$(cd "${script_dir}/../../.." && pwd)"

for command_name in gcloud docker; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command not found: ${command_name}" >&2
    exit 1
  fi
done
docker buildx version >/dev/null

active_project="$(gcloud config get-value project 2>/dev/null)"
if [[ "${active_project}" != "${GCP_PROJECT_ID}" ]]; then
  echo "Active gcloud project is '${active_project}', not '${GCP_PROJECT_ID}'." >&2
  echo "Set the intended project explicitly, then rerun." >&2
  exit 1
fi

gcloud artifacts repositories describe "${repository}" --location="${region}" --project="${GCP_PROJECT_ID}" >/dev/null || {
  echo "Artifact Registry repository '${repository}' must be created after the credit gate." >&2
  echo "No GCP resource was created by this script." >&2
  exit 1
}

echo "This builds and pushes two container images to ${GCP_PROJECT_ID}/${repository}."
read -r -p "Type BUILD to continue: " approval
if [[ "${approval}" != "BUILD" ]]; then
  echo "Build cancelled."
  exit 0
fi

gcloud auth configure-docker "${region}-docker.pkg.dev" --quiet
docker buildx build --platform linux/amd64 --push --tag "${api_image}" --file "${api_root}/Dockerfile" "${api_root}"
docker buildx build --platform linux/amd64 --push --tag "${nginx_image}" --file "${api_root}/deploy/gcp/api/nginx.Dockerfile" "${api_root}"

printf 'API image tag: %s\nNGINX image tag: %s\n' "${api_image}" "${nginx_image}"
echo "Resolve each immutable image digest before deployment:"
echo "  gcloud artifacts docker images describe '${api_image}' --format='value(image_summary.digest)'"
echo "  gcloud artifacts docker images describe '${nginx_image}' --format='value(image_summary.digest)'"
