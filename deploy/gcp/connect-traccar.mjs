#!/usr/bin/env node
// Import only the fresh cloud middleware token, never the Windows development token.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import dotenv from 'dotenv';

process.umask(0o077);
const cli = process.env.GCLOUD_BIN || '/Users/claireantonetteabas/google-cloud-sdk/bin/gcloud';
const project = 'traccar-510507';
const filename = 'deploy/gcp/setup.local.env';
const name = 'superkalan-traccar-token';
function run(args, input) {
  try {
    return execFileSync(cli, [...args, '--quiet'], { input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000 });
  } catch {
    throw new Error(`gcloud ${args.slice(0, 3).join(' ')} failed; secret diagnostics withheld`);
  }
}
try {
  const setup = dotenv.parse(readFileSync(filename));
  if (setup.GCP_IMPLEMENTATION_AUTHORIZATION !== 'OWNER_REQUEST_2026_10_08') throw new Error('Deployment authorization record missing');
  const token = run(['compute', 'ssh', 'superkalan-traccar', `--project=${project}`, '--zone=asia-southeast1-b', '--tunnel-through-iap', '--command=sudo cat /opt/superkalan-traccar/integration-token']);
  if (token.length < 20 || /\s/.test(token.toString())) throw new Error('Unexpected fresh token format');
  let metadata;
  try { metadata = JSON.parse(run(['secrets', 'describe', name, `--project=${project}`, '--format=json'])); } catch { /* Create below. */ }
  if (!metadata) {
    run(['secrets', 'create', name, `--project=${project}`, '--replication-policy=user-managed', '--locations=asia-southeast1', '--labels=application=superkalan,environment=capstone']);
    metadata = JSON.parse(run(['secrets', 'describe', name, `--project=${project}`, '--format=json']));
  }
  if (metadata.replication?.userManaged?.replicas?.map(r => r.location).join(',') !== 'asia-southeast1') throw new Error('Unexpected token replication policy');
  const versions = JSON.parse(run(['secrets', 'versions', 'list', name, `--project=${project}`, '--filter=state:ENABLED', '--sort-by=~createTime', '--limit=1', '--format=json']));
  let version;
  if (versions.length) {
    version = versions[0].name.split('/').at(-1);
    const previous = run(['secrets', 'versions', 'access', version, `--secret=${name}`, `--project=${project}`]);
    if (previous.length !== token.length || !timingSafeEqual(previous, token)) version = undefined;
  }
  if (!version) version = JSON.parse(run(['secrets', 'versions', 'add', name, `--project=${project}`, '--data-file=-', '--format=json'], token)).name.split('/').at(-1);
  let content = readFileSync(filename, 'utf8');
  for (const [key, value] of Object.entries({ TRACCAR_TOKEN_SECRET_NAME: name, TRACCAR_TOKEN_SECRET_VERSION: version, GCP_TRACCAR_INITIALIZATION_STATUS: 'CLOUD_ACCOUNT_TOKEN_VERIFIED' })) {
    const line = `${key}='${value}'`;
    const expression = new RegExp(`^${key}=.*$`, 'm');
    content = expression.test(content) ? content.replace(expression, line) : `${content.trimEnd()}\n${line}\n`;
  }
  writeFileSync(filename, content, { mode: 0o600 });
  console.log(`Fresh cloud Traccar token stored as ${name}:${version}; payload withheld.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
