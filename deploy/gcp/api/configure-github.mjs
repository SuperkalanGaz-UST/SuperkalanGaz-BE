// Owner-run setup only. CI cannot grant IAM permissions or read application secrets.
import { execFileSync } from 'node:child_process';

const project = 'traccar-510507';
const account = `github-api-deployer@${project}.iam.gserviceaccount.com`;
const member = `serviceAccount:${account}`;
const pool = 'github-api';
const provider = 'github-main';
const run = (args) => execFileSync('gcloud', [...args, `--project=${project}`, '--quiet'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
}).trim();
const items = (args) => JSON.parse(run([...args, '--format=json']));
if (process.argv[2] !== '--apply') throw new Error('Use --apply for the owner-authorized GitHub connection.');

run(['services', 'enable', 'sts.googleapis.com', 'iamcredentials.googleapis.com']);
if (!items(['iam', 'service-accounts', 'list']).some((item) => item.email === account)) {
  run(['iam', 'service-accounts', 'create', 'github-api-deployer', '--display-name=GitHub main API deployer']);
}
if (!items(['iam', 'workload-identity-pools', 'list', '--location=global']).some((item) => item.name.endsWith(`/${pool}`))) {
  run(['iam', 'workload-identity-pools', 'create', pool, '--location=global', '--display-name=Backend GitHub Actions']);
}
const mapping = 'google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref,attribute.event_name=assertion.event_name';
const condition = "assertion.repository_id == '1289093855' && assertion.repository_owner_id == '293938016' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == 'SuperkalanGaz-UST/SuperkalanGaz-BE/.github/workflows/deploy-api.yml@refs/heads/main' && assertion.event_name in ['push', 'workflow_dispatch']";
const exists = items(['iam', 'workload-identity-pools', 'providers', 'list', '--location=global', `--workload-identity-pool=${pool}`])
  .some((item) => item.name.endsWith(`/${provider}`));
run(['iam', 'workload-identity-pools', 'providers', exists ? 'update-oidc' : 'create-oidc', provider,
  '--location=global', `--workload-identity-pool=${pool}`, '--issuer-uri=https://token.actions.githubusercontent.com',
  `--attribute-mapping=${mapping}`, `--attribute-condition=${condition}`]);

const roles = [
  ['superkalanApiUpdater', 'Existing API image release', 'run.services.get,run.services.update'],
  ['superkalanReleaseObserver', 'API release operation status', 'run.operations.get'],
];
const existingRoles = items(['iam', 'roles', 'list']);
for (const [id, title, permissions] of roles) {
  run(['iam', 'roles', existingRoles.some((item) => item.name.endsWith(`/${id}`)) ? 'update' : 'create', id,
    `--title=${title}`, `--permissions=${permissions}`, '--stage=GA']);
}
run(['run', 'services', 'add-iam-policy-binding', 'superkalan-crm-api', '--region=asia-southeast1',
  `--member=${member}`, `--role=projects/${project}/roles/superkalanApiUpdater`]);
run(['projects', 'add-iam-policy-binding', project, `--member=${member}`,
  `--role=projects/${project}/roles/superkalanReleaseObserver`, '--condition=None']);
run(['artifacts', 'repositories', 'add-iam-policy-binding', 'superkalan-crm', '--location=asia-southeast1',
  `--member=${member}`, '--role=roles/artifactregistry.writer']);
run(['iam', 'service-accounts', 'add-iam-policy-binding', `superkalan-api@${project}.iam.gserviceaccount.com`,
  `--member=${member}`, '--role=roles/iam.serviceAccountUser', '--condition=None']);
run(['iam', 'service-accounts', 'add-iam-policy-binding', account,
  '--member=principalSet://iam.googleapis.com/projects/597059510567/locations/global/workloadIdentityPools/github-api/attribute.repository_id/1289093855',
  '--role=roles/iam.workloadIdentityUser',
  '--condition=expression=request.time < timestamp("2026-12-19T16:00:00Z"),title=funded-window,description=Approved Manila December 20 cutoff']);
console.log('Configured main-only GitHub federation and scoped release permissions. No application secret, VM or live revision was changed.');
