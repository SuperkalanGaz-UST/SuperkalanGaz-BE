import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { renderService, runtimeConfig } from './render-service.mjs';

// js-yaml is already installed with the repository's Jest/ESLint tools.
const { load } = createRequire(import.meta.url)('js-yaml');
const folder = dirname(fileURLToPath(import.meta.url));
const template = await readFile(join(folder, 'service.yaml.tmpl'), 'utf8');
const env = {
  GCP_PROJECT_ID: 'traccar-510507',
  GCP_VPC_NETWORK: 'superkalan-vpc',
  GCP_VPC_SUBNET: 'superkalan-run-sg',
  GCP_RUNTIME_SERVICE_ACCOUNT: 'superkalan-api@traccar-510507.iam.gserviceaccount.com',
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only',
  DATABASE_SECRET_NAME: 'test-database', DATABASE_SECRET_VERSION: '2',
  SUPABASE_SECRET_KEY_SECRET_NAME: 'test-key', SUPABASE_SECRET_KEY_SECRET_VERSION: '3',
  SUPABASE_DB_CA_SECRET_NAME: 'test-db-ca', SUPABASE_DB_CA_SECRET_VERSION: '4',
  API_IMAGE: `asia-southeast1-docker.pkg.dev/traccar-510507/superkalan-crm/api@sha256:${'a'.repeat(64)}`,
  NGINX_IMAGE: `asia-southeast1-docker.pkg.dev/traccar-510507/superkalan-crm/api-nginx@sha256:${'b'.repeat(64)}`,
};
const jwt = { SUPABASE_JWT_SECRET_SECRET_NAME: 'test-jwt', SUPABASE_JWT_SECRET_SECRET_VERSION: '5' };
const traccar = {
  TRACCAR_BASE_URL: 'https://10.60.0.10',
  TRACCAR_TOKEN_SECRET_NAME: 'test-traccar-token', TRACCAR_TOKEN_SECRET_VERSION: '6',
  TRACCAR_CA_SECRET_NAME: 'test-traccar-ca', TRACCAR_CA_SECRET_VERSION: '7',
};
const fullEnv = { ...env, ...jwt, ...traccar };
function rendered(settings = env) { return load(renderService(template, settings)); }
function apiEnv(service) {
  return Object.fromEntries(service.spec.template.spec.containers[1].env.map((entry) => [entry.name, entry]));
}

test('rendered YAML preserves ingress, network tag, funding-related capacity and TLS', () => {
  const service = rendered();
  const revision = service.spec.template;
  const annotations = revision.metadata.annotations;
  assert.deepEqual(JSON.parse(annotations['run.googleapis.com/network-interfaces']), [{
    network: 'superkalan-vpc', subnetwork: 'superkalan-run-sg', tags: ['superkalan-api'],
  }]);
  assert.deepEqual(JSON.parse(annotations['run.googleapis.com/container-dependencies']), { nginx: ['api'] });
  assert.equal(annotations['run.googleapis.com/vpc-access-egress'], 'private-ranges-only');
  assert.equal(annotations['run.googleapis.com/cpu-throttling'], 'true');
  assert.equal(annotations['run.googleapis.com/execution-environment'], 'gen1');
  assert.equal(annotations['autoscaling.knative.dev/minScale'], '0');
  assert.equal(annotations['autoscaling.knative.dev/maxScale'], '2');
  assert.equal(revision.spec.containerConcurrency, 1);
  assert.equal(revision.spec.timeoutSeconds, 60);
  const [nginx, api] = revision.spec.containers;
  assert.deepEqual(nginx.ports, [{ name: 'http1', containerPort: 8080 }]);
  assert.equal(api.ports, undefined);
  assert.equal(nginx.resources.limits.cpu, '500m');
  assert.equal(api.resources.limits.cpu, '1');
  for (const [container, port] of [[nginx, 8080], [api, 3001]]) {
    assert.deepEqual(container.startupProbe.httpGet, { path: '/api/health/ready', port });
    assert.ok(container.startupProbe.timeoutSeconds <= container.startupProbe.periodSeconds);
    assert.ok(container.startupProbe.periodSeconds * container.startupProbe.failureThreshold <= 240);
  }
  assert.equal(api.livenessProbe.httpGet.path, '/api/health/live');
  assert.equal(api.readinessProbe, undefined);
  const settings = apiEnv(service);
  assert.equal(settings.DATABASE_SSL_REJECT_UNAUTHORIZED.value, 'true');
  assert.equal(settings.DATABASE_SSL_CA_CERT_PATH.value, '/var/run/secrets/supabase/root.crt');
  assert.equal(revision.spec.volumes[0].secret.items[0].mode, 0o444);
  assert.equal(settings.SUPABASE_JWT_SECRET, undefined);
  assert.equal(settings.TRACCAR_TOKEN, undefined);
  assert.equal(settings.NODE_EXTRA_CA_CERTS, undefined);
});

test('legacy JWT and Traccar secrets use pinned references and separate readable CA mounts', () => {
  const service = rendered(fullEnv);
  const settings = apiEnv(service);
  assert.deepEqual(settings.SUPABASE_JWT_SECRET.valueFrom.secretKeyRef, { name: 'test-jwt', key: '5' });
  assert.deepEqual(settings.SUPABASE_SECRET_KEY.valueFrom.secretKeyRef, { name: 'test-key', key: '3' });
  assert.deepEqual(settings.TRACCAR_TOKEN.valueFrom.secretKeyRef, { name: 'test-traccar-token', key: '6' });
  assert.equal(settings.TRACCAR_BASE_URL.value, 'https://10.60.0.10');
  assert.equal(settings.NODE_EXTRA_CA_CERTS.value, '/var/run/secrets/traccar/root.crt');
  assert.deepEqual(service.spec.template.spec.volumes[1].secret, {
    secretName: 'test-traccar-ca', items: [{ key: '7', path: 'root.crt', mode: 0o444 }],
  });
  assert.equal(service.spec.template.spec.containers[0].volumeMounts, undefined);
  assert.equal(service.spec.template.spec.containers[1].volumeMounts[1].readOnly, true);
  assert.equal(runtimeConfig(fullEnv).secretRefs.length, 6);
});

test('optional JWT and Traccar groups render independently', () => {
  assert.equal(runtimeConfig({ ...env, ...jwt }).secretRefs.length, 4);
  assert.equal(runtimeConfig({ ...env, ...traccar }).secretRefs.length, 5);
  assert.equal(apiEnv(rendered({ ...env, ...traccar })).SUPABASE_JWT_SECRET, undefined);
});

test('CA trust can be prepared independently before enabling Traccar calls', () => {
  const settings = { ...env, ...jwt, TRACCAR_CA_SECRET_NAME: 'superkalan-traccar-ca',
    TRACCAR_CA_SECRET_VERSION: '1' };
  const service = rendered(settings);
  assert.equal(runtimeConfig(settings).secretRefs.length, 5);
  assert.equal(apiEnv(service).NODE_EXTRA_CA_CERTS.value, '/var/run/secrets/traccar/root.crt');
  assert.equal(apiEnv(service).TRACCAR_BASE_URL, undefined);
  assert.equal(apiEnv(service).TRACCAR_TOKEN, undefined);
  assert.throws(() => rendered({ ...env, TRACCAR_BASE_URL: 'https://10.60.0.10' }), /TRACCAR_TOKEN_SECRET_NAME/);
});

test('renderer never consumes or leaks raw credential payloads', () => {
  const sentinel = 'PRIVATE_TEST_PAYLOAD_DO_NOT_RENDER';
  const output = renderService(template, { ...fullEnv, DATABASE_URL: sentinel,
    SUPABASE_SECRET_KEY: sentinel, SUPABASE_SERVICE_ROLE_KEY: sentinel,
    SUPABASE_JWT_SECRET: sentinel, TRACCAR_TOKEN: sentinel });
  assert.ok(!output.includes(sentinel));
  assert.ok(!output.includes('__OPTIONAL_'));
});

test('reject missing required inputs and partial optional secret groups', () => {
  for (const name of Object.keys(env)) {
    assert.throws(() => runtimeConfig({ ...env, [name]: '' }), new RegExp(name));
  }
  for (const name of Object.keys(jwt)) {
    assert.throws(() => runtimeConfig({ ...env, ...jwt, [name]: '' }), new RegExp(name));
  }
  for (const name of Object.keys(traccar)) {
    if (name === 'TRACCAR_BASE_URL') continue; // Trust and token may be staged first.
    assert.throws(() => runtimeConfig({ ...fullEnv, [name]: '' }), new RegExp(name));
  }
});

test('reject unsafe URLs, unpinned or foreign images, and invalid secret versions', () => {
  const invalid = [
    ['SUPABASE_URL', 'https://user:PRIVATE_TEST_PAYLOAD@project.supabase.co'],
    ['SUPABASE_URL', 'https://project.supabase.co/?token=PRIVATE_TEST_PAYLOAD'],
    ['SUPABASE_URL', 'http://project.supabase.co'],
    ['API_WEB_ORIGIN', 'https://example.com/,https://valid.example.com'],
    ['API_WEB_ORIGIN', 'https://example.com,,https://valid.example.com'],
    ['GCP_VPC_NETWORK', 'network-'],
    ['GCP_VPC_SUBNET', "subnet'\ninvalid"],
    ['GCP_RUNTIME_SERVICE_ACCOUNT', 'superkalan-api@other-project.iam.gserviceaccount.com'],
    ['API_IMAGE', env.API_IMAGE.replace('traccar-510507', 'other-project')],
    ['NGINX_IMAGE', env.NGINX_IMAGE.replace(/@sha256:.*/, ':latest')],
    ['DATABASE_SECRET_VERSION', 'latest'], ['DATABASE_SECRET_VERSION', '0'],
    ['SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_'],
    ['TRACCAR_BASE_URL', 'http://10.60.0.10'],
    ['TRACCAR_BASE_URL', 'https://10.60.0.10:8082'],
    ['TRACCAR_BASE_URL', 'https://public.example.com'],
  ];
  for (const [name, value] of invalid) {
    assert.throws(() => runtimeConfig({ ...fullEnv, [name]: value }), (error) => {
      assert.ok(!error.message.includes('PRIVATE_TEST_PAYLOAD'));
      return error.message.includes(name);
    });
  }
  assert.throws(() => runtimeConfig({ ...env, SUPABASE_DB_CA_SECRET_NAME: env.DATABASE_SECRET_NAME }), /distinct/);
  assert.throws(() => renderService(`${template}\n__UNRESOLVED__`, env), /unresolved/);
});

test('CORS origins and valid Secret Manager IDs survive YAML parsing exactly', () => {
  const service = rendered({ ...env, API_WEB_ORIGIN: 'https://web.example.com,http://localhost:3000',
    DATABASE_SECRET_NAME: 'API_DATABASE_01' });
  assert.equal(apiEnv(service).WEB_ORIGIN.value, 'https://web.example.com,http://localhost:3000');
  assert.equal(apiEnv(service).DATABASE_URL.valueFrom.secretKeyRef.name, 'API_DATABASE_01');
});

// The fake CLI logs commands and fails closed on anything unexpected. It never
// calls GCP; even the confirmed-release test mutates only a disposable folder.
const fakeGcloud = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$*" in
  'config get-value project') echo "\${MOCK_PROJECT:-traccar-510507}" ;;
  artifacts*describe*|iam*describe*) ;;
  'secrets versions describe'*) echo "\${MOCK_SECRET_STATE:-ENABLED}" ;;
  'compute networks subnets describe'*) echo "https://www.googleapis.com/compute/v1/projects/traccar-510507/global/networks/\${MOCK_NETWORK:-superkalan-vpc}" ;;
  'secrets add-iam-policy-binding'*) ;;
  'run services replace'*) cp "$4" "$MOCK_MANIFEST" ;;
  *) echo 'Unexpected mock command' >&2; exit 90 ;;
esac
`;

async function deployMock(overrides, input) {
  const temp = await mkdtemp(join(folder, '.deployment-test-'));
  try {
    await writeFile(join(temp, 'gcloud'), fakeGcloud, { mode: 0o700 });
    const settings = { ...fullEnv, PATH: `${temp}:${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: temp, MOCK_LOG: join(temp, 'calls'), MOCK_MANIFEST: join(temp, 'manifest'),
      CREDIT_GATE_APPROVED: 'YES', RELEASE_APPROVED: 'YES', ...overrides };
    const result = spawnSync('/bin/bash', [join(folder, 'deploy-service.sh')], {
      env: settings, input, encoding: 'utf8', timeout: 10_000,
    });
    const calls = await readFile(settings.MOCK_LOG, 'utf8').catch(() => '');
    const manifest = await readFile(settings.MOCK_MANIFEST, 'utf8').catch(() => '');
    assert.equal(result.error, undefined);
    assert.ok(!calls.includes('versions access'));
    return { ...result, calls, manifest };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test('funding/release gates and invalid render inputs fail before any cloud check', async () => {
  for (const overrides of [{ CREDIT_GATE_APPROVED: '' }, { RELEASE_APPROVED: '' },
    { TRACCAR_CA_SECRET_VERSION: 'latest' }]) {
    const result = await deployMock(overrides, 'DEPLOY\n');
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, '');
  }
});

test('wrong project/network and disabled secrets prevent cloud mutations', async () => {
  for (const [overrides, expected] of [[{ MOCK_PROJECT: 'other-project' }, /Active gcloud project/],
    [{ MOCK_NETWORK: 'default' }, /not attached/], [{ MOCK_SECRET_STATE: 'DISABLED' }, /must be ENABLED/]]) {
    const result = await deployMock(overrides, 'DEPLOY\n');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.ok(!result.calls.includes('add-iam-policy-binding'));
    assert.ok(!result.calls.includes('run services replace'));
  }
});

test('cancellation makes metadata checks only, with no IAM or deployment write', async () => {
  const result = await deployMock({}, 'CANCEL\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.calls.match(/secrets versions describe/g) ?? []).length, 6);
  assert.ok(!result.calls.includes('add-iam-policy-binding'));
  assert.ok(!result.calls.includes('run services replace'));
});

test('confirmed mock release grants only referenced secrets and deploys the rendered YAML', async () => {
  const result = await deployMock({}, 'DEPLOY\n');
  assert.equal(result.status, 0, result.stderr);
  const bindings = result.calls.split('\n').filter((line) => line.startsWith('secrets add-iam-policy-binding'));
  assert.equal(bindings.length, 6);
  for (const ref of runtimeConfig(fullEnv).secretRefs) {
    assert.ok(bindings.some((line) => line.startsWith(`secrets add-iam-policy-binding ${ref.name} `)));
  }
  assert.ok(bindings.every((line) => line.includes('--role=roles/secretmanager.secretAccessor')));
  assert.deepEqual(load(result.manifest), rendered(fullEnv));
});
