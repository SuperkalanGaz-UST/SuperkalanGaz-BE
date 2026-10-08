#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { renderService, runtimeConfig } from './api/render-service.mjs';

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const filename = resolve(root, 'deploy/gcp/setup.local.env');
const setup = dotenv.parse(readFileSync(filename));
const source = dotenv.parse(readFileSync(resolve(root, '.env')));
const cli = process.env.GCLOUD_BIN || '/Users/claireantonetteabas/google-cloud-sdk/bin/gcloud';
const mode = process.argv[2] || '--validate';
const project = 'traccar-510507';
const registry = `asia-southeast1-docker.pkg.dev/${project}/superkalan-crm`;
function run(args, options = {}) {
  try {
    return execFileSync(cli, [...args, '--quiet'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 240000, ...options }).trim();
  } catch (error) {
    let diagnostic = error.stderr?.toString() || 'Command failed';
    for (const value of Object.values(source)) if (value.length > 4) diagnostic = diagnostic.replaceAll(value, '[redacted]');
    throw new Error(diagnostic.slice(0, 2200));
  }
}
try {
  if (!['--validate', '--deploy'].includes(mode)) throw new Error('Use --validate or --deploy');
  if (run(['config', 'get-value', 'project']) !== project || setup.GCP_PROJECT_ID !== project) throw new Error('Project mismatch');
  if (setup.GCP_IMPLEMENTATION_AUTHORIZATION !== 'OWNER_REQUEST_2026_10_08' || setup.GCP_BUDGET_ALERTS_STATUS !== 'CREATED_GROSS_USAGE_150_USD' || setup.GCP_NETWORK_REVIEW_REQUIRED !== 'NO') throw new Error('Infrastructure preparation record is incomplete');
  const apiDigest = run(['artifacts', 'docker', 'images', 'describe', `${registry}/api:prepared-20261008`, `--project=${project}`, '--format=value(image_summary.digest)']);
  const nginxDigest = run(['artifacts', 'docker', 'images', 'describe', `${registry}/api-nginx:prepared-20261008`, `--project=${project}`, '--format=value(image_summary.digest)']);
  const env = { ...setup, API_IMAGE: `${registry}/api@${apiDigest}`, NGINX_IMAGE: `${registry}/api-nginx@${nginxDigest}`, API_WEB_ORIGIN: source.WEB_ORIGIN || 'http://localhost:3000' };
  // Infrastructure-first release may mount the CA before the fresh middleware
  // integration token exists; do not borrow the Windows Traccar token.
  if (!env.TRACCAR_TOKEN_SECRET_NAME) delete env.TRACCAR_BASE_URL;
  const config = runtimeConfig(env);
  for (const ref of config.secretRefs) {
    const state = run(['secrets', 'versions', 'describe', ref.version, `--secret=${ref.name}`, `--project=${project}`, '--format=value(state)']);
    if (state !== 'ENABLED') throw new Error(`Secret version ${ref.name}:${ref.version} is not enabled`);
    run(['secrets', 'add-iam-policy-binding', ref.name, `--member=serviceAccount:${config.serviceAccount}`, '--role=roles/secretmanager.secretAccessor', `--project=${project}`]);
  }
  const manifest = resolve(root, 'deploy/gcp/.local/service.yaml');
  writeFileSync(manifest, renderService(readFileSync(resolve(root, 'deploy/gcp/api/service.yaml.tmpl'), 'utf8'), env), { mode: 0o600 });
  run(['run', 'services', 'replace', manifest, `--project=${project}`, '--region=asia-southeast1', '--dry-run']);
  console.log('Google Cloud accepted the rendered service in dry-run validation.');
  if (mode === '--deploy') {
    run(['run', 'services', 'replace', manifest, `--project=${project}`, '--region=asia-southeast1']);
    const result = JSON.parse(run(['run', 'services', 'describe', 'superkalan-crm-api', `--project=${project}`, '--region=asia-southeast1', '--format=json']));
    writeFileSync(resolve(root, 'deploy/gcp/.local/api-release.json'), JSON.stringify({ url: result.status.url, readyRevision: result.status.latestReadyRevisionName, apiImage: env.API_IMAGE, nginxImage: env.NGINX_IMAGE, secrets: config.secretRefs, traccarConfigured: Boolean(config.traccar) }, null, 2) + '\n', { mode: 0o600 });
    console.log('Cloud Run ready URL:', result.status.url);
    console.log('Ready revision:', result.status.latestReadyRevisionName);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Release failed');
  process.exitCode = 1;
}
