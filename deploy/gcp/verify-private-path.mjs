#!/usr/bin/env node
// One read-only, temporary Cloud Run job proves the VPC/TLS/auth path. No device writes.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

process.umask(0o077);
const cli = process.env.GCLOUD_BIN || '/Users/claireantonetteabas/google-cloud-sdk/bin/gcloud';
const project = 'traccar-510507';
const job = `superkalan-private-check-${Date.now().toString(36)}`;
const release = JSON.parse(readFileSync('deploy/gcp/.local/api-release.json'));
const common = [`--project=${project}`, '--region=asia-southeast1', '--quiet'];
function run(args) {
  try { return execFileSync(cli, [...args, ...common], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000 }).trim(); }
  catch { throw new Error(`gcloud ${args.slice(0, 3).join(' ')} failed; inspect the temporary job, without exposing credentials`); }
}
const code = `
let success = false;
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    const url = 'https://10.60.0.10/api/devices';
    const anonymous = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (anonymous.status !== 401) throw new Error('Anonymous access was not rejected');
    const response = await fetch(url, { headers: { Authorization: 'Bearer ' + process.env.TRACCAR_TOKEN }, signal: AbortSignal.timeout(5000) });
    if (response.status !== 200 || !Array.isArray(await response.json())) throw new Error('Authenticated read failed');
    console.log('PASS: private VPC, verified TLS, anonymous rejection, authenticated Traccar read.');
    success = true; break;
  } catch { await new Promise(resolve => setTimeout(resolve, 5000)); }
}
if (!success) { console.error('FAIL: private middleware path; response bodies withheld.'); process.exit(1); }
`;
let created = false;
try {
  if (!release.traccarConfigured) throw new Error('Release must reference the fresh middleware token first');
  const result = run(['run', 'jobs', 'create', job, `--image=${release.apiImage}`, '--service-account=superkalan-api@traccar-510507.iam.gserviceaccount.com', '--network=superkalan-vpc', '--subnet=superkalan-run-sg', '--network-tags=superkalan-api', '--vpc-egress=private-ranges-only', '--cpu=1', '--memory=512Mi', '--max-retries=0', '--task-timeout=180s', '--command=node', `--args=^~^--input-type=module~-e~${code}`, '--set-env-vars=NODE_EXTRA_CA_CERTS=/var/run/secrets/traccar/ca.crt', '--set-secrets=TRACCAR_TOKEN=superkalan-traccar-token:1,/var/run/secrets/traccar/ca.crt=superkalan-traccar-ca:1', '--format=json']);
  created = true;
  JSON.parse(result);
  const execution = JSON.parse(run(['run', 'jobs', 'execute', job, '--wait', '--format=json']));
  const conditions = execution.status?.conditions || [];
  if (!conditions.some(c => c.type === 'Completed' && c.status === 'True')) throw new Error('Private-path execution did not complete successfully');
  writeFileSync('deploy/gcp/.local/private-path-check.json', JSON.stringify({ checkedAt: new Date().toISOString(), execution: execution.metadata.name, passed: true, checks: ['private VPC', 'certificate and IP verification', 'anonymous HTTP 401', 'authenticated HTTP 200 array'], productionDeviceWrites: 0 }, null, 2) + '\n', { mode: 0o600 });
  console.log('PASS: Cloud Run private VPC → verified HTTPS → authenticated Traccar API.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (created) {
    try { run(['run', 'jobs', 'delete', job]); console.log('Temporary verification job deleted.'); }
    catch { console.error(`Cleanup required for temporary job ${job}`); process.exitCode = 1; }
  }
}
