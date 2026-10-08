#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { X509Certificate, timingSafeEqual } from 'node:crypto';
import dotenv from 'dotenv';

process.umask(0o077);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const local = resolve(root, 'deploy/gcp/.local');
const project = 'traccar-510507';
const region = 'asia-southeast1';
const billing = '016854-D3B7A0-49F71A';
const network = 'superkalan-vpc';
const runAccount = `superkalan-api@${project}.iam.gserviceaccount.com`;
const vmAccount = `superkalan-traccar@${project}.iam.gserviceaccount.com`;
const cli = process.env.GCLOUD_BIN || (existsSync('/Users/claireantonetteabas/google-cloud-sdk/bin/gcloud') ? '/Users/claireantonetteabas/google-cloud-sdk/bin/gcloud' : 'gcloud');
const mode = process.argv[2] || '--plan';

function command(args, input, optional = false) {
  try {
    return execFileSync(cli, [...args, '--quiet'], {
      input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000,
    }).trim();
  } catch (error) {
    if (optional) return null;
    // Secret payloads go only through stdin; do not copy subprocess diagnostics into logs.
    throw new Error(`gcloud ${args.slice(0, 3).join(' ')} failed (exit ${error.status ?? 'timeout'}). Review the named resource without exposing its payload.`);
  }
}
function json(args, optional = false) {
  const result = command([...args, '--format=json'], undefined, optional);
  return result === null ? null : JSON.parse(result);
}
function artifact(name, contents) {
  mkdirSync(local, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(local, name), contents, { mode: 0o600 });
}
function setConfig(updates) {
  const filename = resolve(root, 'deploy/gcp/setup.local.env');
  let contents = existsSync(filename) ? readFileSync(filename, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /['\r\n]/.test(value)) throw new Error('Invalid configuration value');
    const line = `${key}='${value}'`;
    const expression = new RegExp(`^${key}=.*$`, 'm');
    contents = expression.test(contents) ? contents.replace(expression, line) : `${contents.trimEnd()}\n${line}\n`;
  }
  writeFileSync(filename, contents, { mode: 0o600 });
}
async function certificate() {
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt', { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Cannot retrieve Supabase public CA certificate');
  const contents = await response.text();
  const cert = new X509Certificate(contents);
  const fingerprint = '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';
  if (!cert.ca || cert.fingerprint256 !== fingerprint || new Date(cert.validTo) <= new Date()) {
    throw new Error('Supabase CA certificate identity or validity changed; review before trusting it');
  }
  artifact('supabase-ca.crt', contents);
  chmodSync(resolve(local, 'supabase-ca.crt'), 0o644);
  return contents;
}
function secret(name, payload) {
  if (!payload) throw new Error(`Missing input for ${name}`);
  let metadata = json(['secrets', 'describe', name, `--project=${project}`], true);
  if (!metadata) {
    command(['secrets', 'create', name, `--project=${project}`, '--replication-policy=user-managed', `--locations=${region}`, '--labels=application=superkalan,environment=capstone']);
    metadata = json(['secrets', 'describe', name, `--project=${project}`]);
  }
  const replicas = metadata.replication?.userManaged?.replicas;
  if (!replicas || replicas.length !== 1 || replicas[0].location !== region) throw new Error(`Unexpected replication for ${name}`);
  const versions = json(['secrets', 'versions', 'list', name, `--project=${project}`, '--filter=state:ENABLED', '--sort-by=~createTime', '--limit=1']);
  let version;
  if (versions.length) {
    version = versions[0].name.split('/').at(-1);
    const previous = execFileSync(cli, ['secrets', 'versions', 'access', version, `--secret=${name}`, `--project=${project}`, '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const next = Buffer.from(payload);
    if (previous.length !== next.length || !timingSafeEqual(previous, next)) version = undefined;
  }
  if (!version) {
    const result = jsonUpload(name, payload);
    version = result.name.split('/').at(-1);
  }
  console.log(`${name}: version ${version} configured`);
  return version;
}
function jsonUpload(name, payload) {
  return JSON.parse(command(['secrets', 'versions', 'add', name, `--project=${project}`, '--data-file=-', '--format=json'], payload));
}
async function secrets() {
  const env = dotenv.parse(readFileSync(resolve(root, '.env')));
  const setup = dotenv.parse(readFileSync(resolve(root, 'deploy/gcp/setup.local.env')));
  if (env.SUPABASE_URL !== setup.SUPABASE_URL) throw new Error('Supabase project mismatch');
  const ca = await certificate();
  const inputs = [
    ['superkalan-database-url', env.DATABASE_URL, 'DATABASE_SECRET'],
    ['superkalan-supabase-secret-key', env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SECRET_KEY_SECRET'],
    ['superkalan-supabase-db-ca', ca, 'SUPABASE_DB_CA_SECRET'],
    ['superkalan-supabase-jwt-secret', env.SUPABASE_JWT_SECRET, 'SUPABASE_JWT_SECRET_SECRET'],
  ];
  // Validate every source before making any secret write.
  for (const [name, payload] of inputs) if (!payload) throw new Error(`Missing environment source for ${name}`);
  const updates = {};
  for (const [name, payload, prefix] of inputs) {
    updates[`${prefix}_NAME`] = name;
    updates[`${prefix}_VERSION`] = secret(name, payload);
  }
  updates.SUPABASE_SECRET_UPLOAD_STATUS = 'UPLOADED_FROM_LOCAL_ENV';
  setConfig(updates);
}
function infrastructure() {
  command(['services', 'enable', 'billingbudgets.googleapis.com', 'iap.googleapis.com', 'compute.googleapis.com', 'run.googleapis.com', 'artifactregistry.googleapis.com', 'secretmanager.googleapis.com', `--project=${project}`]);
  const budgets = json(['billing', 'budgets', 'list', `--billing-account=${billing}`]);
  const title = 'Superkalan trial window 150 USD';
  if (!budgets.some(b => b.displayName === title)) {
    command(['billing', 'budgets', 'create', `--billing-account=${billing}`, `--display-name=${title}`, '--budget-amount=150USD', `--filter-projects=projects/${project}`, '--start-date=2026-10-08', '--end-date=2027-01-03', '--credit-types-treatment=exclude-all-credits', '--threshold-rule=percent=0.5', '--threshold-rule=percent=0.75', '--threshold-rule=percent=0.9', '--threshold-rule=percent=1']);
  }
  console.log('Credit-window alerts configured; promotional credits cannot mask gross usage. Alerts do not cap spend.');
  let vpc = json(['compute', 'networks', 'describe', network, `--project=${project}`], true);
  if (!vpc) {
    command(['compute', 'networks', 'create', network, '--subnet-mode=custom', '--bgp-routing-mode=regional', `--project=${project}`]);
    vpc = json(['compute', 'networks', 'describe', network, `--project=${project}`]);
  }
  if (vpc.autoCreateSubnetworks !== false) throw new Error('Deployment VPC must use custom subnets');
  for (const [name, range] of [['superkalan-vm-sg', '10.60.0.0/28'], ['superkalan-run-sg', '10.60.1.0/26']]) {
    let subnet = json(['compute', 'networks', 'subnets', 'describe', name, `--region=${region}`, `--project=${project}`], true);
    if (!subnet) {
      command(['compute', 'networks', 'subnets', 'create', name, `--network=${network}`, `--range=${range}`, `--region=${region}`, `--project=${project}`]);
      subnet = json(['compute', 'networks', 'subnets', 'describe', name, `--region=${region}`, `--project=${project}`]);
    }
    if (subnet.ipCidrRange !== range || !subnet.network.endsWith(`/networks/${network}`)) throw new Error(`Unexpected subnet ${name}`);
    console.log(`${name}: ${range}`);
  }
  for (const [name, port, source] of [
    ['superkalan-traccar-device', '5013', '0.0.0.0/0'],
    ['superkalan-traccar-private-api', '443', '10.60.1.0/26'],
    ['superkalan-traccar-iap-ssh', '22', '35.235.240.0/20'],
  ]) {
    let rule = json(['compute', 'firewall-rules', 'describe', name, `--project=${project}`], true);
    if (!rule) {
      command(['compute', 'firewall-rules', 'create', name, `--network=${network}`, '--direction=INGRESS', '--priority=1000', `--allow=tcp:${port}`, `--source-ranges=${source}`, '--target-tags=superkalan-traccar', `--project=${project}`]);
      rule = json(['compute', 'firewall-rules', 'describe', name, `--project=${project}`]);
    }
    if (rule.network.split('/').at(-1) !== network || rule.direction !== 'INGRESS' || rule.sourceRanges?.join(',') !== source || rule.targetTags?.join(',') !== 'superkalan-traccar' || rule.allowed?.length !== 1 || rule.allowed[0].IPProtocol !== 'tcp' || rule.allowed[0].ports?.join(',') !== port) throw new Error(`Unexpected firewall ${name}`);
    console.log(`${name}: TCP ${port}, source ${source}`);
  }
  for (const [id, email] of [['superkalan-api', runAccount], ['superkalan-traccar', vmAccount]]) {
    if (!json(['iam', 'service-accounts', 'describe', email, `--project=${project}`], true)) command(['iam', 'service-accounts', 'create', id, `--display-name=${id} runtime`, `--project=${project}`]);
  }
  if (!json(['artifacts', 'repositories', 'describe', 'superkalan-crm', `--location=${region}`, `--project=${project}`], true)) command(['artifacts', 'repositories', 'create', 'superkalan-crm', '--repository-format=docker', `--location=${region}`, '--labels=application=superkalan,environment=capstone', `--project=${project}`]);
  setConfig({ GCP_VPC_NETWORK: network, GCP_VPC_SUBNET: 'superkalan-run-sg', GCP_VM_SUBNET: 'superkalan-vm-sg', GCP_RUNTIME_SERVICE_ACCOUNT: runAccount, GCP_VM_SERVICE_ACCOUNT: vmAccount, GCP_VM_PRIVATE_IP: '10.60.0.10', GCP_NETWORK_REVIEW_REQUIRED: 'NO', GCP_BUDGET_ALERTS_STATUS: 'CREATED_GROSS_USAGE_150_USD', GCP_IMPLEMENTATION_AUTHORIZATION: 'OWNER_REQUEST_2026_10_08', GCP_COST_ESTIMATE_USD: '145', GCP_COST_REVIEW_STATUS: 'CONDITIONAL_500K_SCENARIO_RUNTIME_MEASUREMENT_PENDING' });
}

function privateTls() {
  mkdirSync(local, { recursive: true, mode: 0o700 });
  const dir = resolve(local, 'private-tls');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const run = args => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const caKey = resolve(dir, 'ca.key');
  const ca = resolve(dir, 'ca.crt');
  const key = resolve(dir, 'traccar-api.key');
  const crt = resolve(dir, 'traccar-api.crt');
  if (!existsSync(caKey) && !existsSync(ca)) {
    run(['genrsa', '-out', caKey, '3072']);
    run(['req', '-x509', '-new', '-sha256', '-key', caKey, '-days', '3650', '-subj', '/O=Superkalan Gaz/CN=Superkalan private API CA', '-out', ca]);
  }
  if (!existsSync(caKey) || !existsSync(ca)) throw new Error('Incomplete private CA; recover the existing files instead of regenerating');
  if (!existsSync(key) && !existsSync(crt)) {
    run(['genrsa', '-out', key, '2048']);
    const csr = resolve(dir, 'traccar-api.csr');
    run(['req', '-new', '-key', key, '-subj', '/O=Superkalan Gaz/CN=10.60.0.10', '-out', csr]);
    const config = resolve(dir, 'server.extensions');
    writeFileSync(config, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:10.60.0.10\n', { mode: 0o600 });
    run(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAserial', resolve(dir, 'ca.srl'), '-CAcreateserial', '-days', '90', '-sha256', '-extfile', config, '-out', crt]);
  }
  if (!existsSync(key) || !existsSync(crt)) throw new Error('Incomplete server certificate; recover existing files');
  run(['verify', '-CAfile', ca, crt]);
  const cert = new X509Certificate(readFileSync(crt));
  if (cert.checkIP('10.60.0.10') !== '10.60.0.10' || new Date(cert.validTo) < new Date('2026-12-20')) throw new Error('Private certificate IP or validity mismatch');
  const version = secret('superkalan-traccar-ca', readFileSync(ca, 'utf8'));
  setConfig({ TRACCAR_CA_SECRET_NAME: 'superkalan-traccar-ca', TRACCAR_CA_SECRET_VERSION: version, TRACCAR_BASE_URL: 'https://10.60.0.10', GCP_PRIVATE_TLS_STATUS: 'GENERATED_VERIFIED_PRIVATE_CA' });
  console.log('Private Traccar TLS certificate generated and verified for 10.60.0.10; private keys remain in the ignored local folder.');
}

try {
  if (!['--plan', '--certificate', '--apply-secrets', '--apply-infrastructure', '--apply-private-tls'].includes(mode)) throw new Error('Unknown mode');
  if (mode === '--plan') {
    console.log('Project traccar-510507; Singapore; reserve US$150; stop 2026-12-20.');
    console.log('Prepare dedicated VPC, VM /28 subnet, Cloud Run /26 subnet, narrowly targeted device/private API/IAP rules, two runtime identities, image repository, and a US$150 gross-usage alert budget.');
    console.log('Upload four API secrets from .env and the verified Supabase CA. No VM or Cloud Run service is created by this helper.');
  } else {
    if (command(['config', 'get-value', 'project']) !== project) throw new Error('Active gcloud project mismatch');
    const linked = json(['billing', 'projects', 'describe', project]);
    if (!linked.billingEnabled || linked.billingAccountName !== `billingAccounts/${billing}`) throw new Error('Billing link mismatch');
    if (mode === '--certificate') await certificate();
    if (mode === '--apply-secrets') await secrets();
    if (mode === '--apply-infrastructure') infrastructure();
    if (mode === '--apply-private-tls') privateTls();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Preparation failed');
  process.exitCode = 1;
}
