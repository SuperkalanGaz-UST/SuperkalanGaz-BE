# Main-branch deployment

Pushing or merging into `main` runs `.github/workflows/deploy-api.yml`. The initial
setup verifies the GitHub → Google Cloud connection but preserves the live revision:
`main` is older than the deployed backend. Merge `develop`, including commit
`2ad5148634e8747855657eaf0b7c077b662f0a84`, into `main` to satisfy the baseline gate.
Keep merge ancestry; squash-merging that baseline will require reviewing this gate.
Uncommitted work is never included in a release.

After that gate passes, lint, unit tests, deployment tests and build must pass before
publishing the API and NGINX images. A no-traffic candidate uses immutable digests;
health and unauthenticated-rejection checks must pass before it receives 100% traffic.
Failures before promotion preserve the previous serving revision. The Actions summary
records the commit, URL and previous revision. Deployment runs are serialized.

Authentication uses GitHub OIDC / Workload Identity Federation; no service-account key
or application secret is stored in GitHub. The provider accepts only this repository's
numeric owner/repository IDs, `main`, and this workflow. The deployer has access only
to the existing Cloud Run service, image repository, runtime service-account use and
operation status. Runtime secrets remain in Google Secret Manager. The deployer cannot
read secret payloads or modify the Traccar VM.

The image-only update retains the API URL, runtime configuration, NGINX, private VPC,
Traccar integration, secret versions and capacity settings. Environment/secret changes
need a separate configuration update. This workflow never runs SQL migrations or seeds;
review and apply compatible schema changes before merging code that needs them.

Automatic releases stop at **2026-12-20 00:00 Asia/Manila**, the approved cutoff. This
does not stop existing Cloud Run resources or change billing. GitHub Actions minutes,
container storage and runtime usage still count toward their respective allowances.

Rollback (owner-authenticated CLI; use the previous revision from the run summary):

```sh
gcloud run services update-traffic superkalan-crm-api \
  --project=traccar-510507 --region=asia-southeast1 \
  --to-revisions=PREVIOUS_REVISION=100
```

Primary references: [Google authentication action](https://github.com/google-github-actions/auth),
[deployment federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines),
and [Cloud Run service updates](https://docs.cloud.google.com/sdk/gcloud/reference/run/services/update).
