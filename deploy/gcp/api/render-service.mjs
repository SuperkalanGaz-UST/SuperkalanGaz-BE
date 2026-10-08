#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before rendering the Cloud Run service`);
  return value;
}

function resourceName(name, value) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    throw new Error(`${name} must be a lowercase GCP resource name`);
  }
  return value;
}

function secretVersion(name, value) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a numeric Secret Manager version`);
  return value;
}

function imageDigest(name, value) {
  if (!/^asia-southeast1-docker\.pkg\.dev\/[^\s@]+@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be an asia-southeast1 Artifact Registry image pinned by digest`);
  }
  return value;
}

const templatePath = process.argv[2];
if (!templatePath) throw new Error('Usage: render-service.mjs <service.yaml.tmpl>');

const network = resourceName('GCP_VPC_NETWORK', required('GCP_VPC_NETWORK'));
const subnet = resourceName('GCP_VPC_SUBNET', required('GCP_VPC_SUBNET'));
const serviceAccount = required('GCP_RUNTIME_SERVICE_ACCOUNT');
if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount)) {
  throw new Error('GCP_RUNTIME_SERVICE_ACCOUNT must be a service-account email');
}

const supabaseUrl = new URL(required('SUPABASE_URL'));
if (supabaseUrl.protocol !== 'https:' || supabaseUrl.pathname !== '/') {
  throw new Error('SUPABASE_URL must be an HTTPS project origin without a path');
}
const supabasePublishableKey = required('SUPABASE_PUBLISHABLE_KEY');
if (!supabasePublishableKey.startsWith('sb_publishable_')) {
  throw new Error('SUPABASE_PUBLISHABLE_KEY must use the current sb_publishable_ format');
}

const webOrigins = (process.env.API_WEB_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
if (webOrigins.length === 0) throw new Error('API_WEB_ORIGIN must contain at least one origin');
for (const origin of webOrigins) {
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
    throw new Error(`Invalid API_WEB_ORIGIN entry: ${origin}`);
  }
}

const values = {
  // Cloud Run's network-interfaces annotation is a JSON array, even when the
  // service attaches only one Direct VPC interface.
  __VPC_NETWORKS_JSON__: JSON.stringify([{ network, subnetwork: subnet }])
    .replaceAll("'", "''"),
  __RUNTIME_SERVICE_ACCOUNT__: JSON.stringify(serviceAccount),
  __NGINX_IMAGE__: JSON.stringify(imageDigest('NGINX_IMAGE', required('NGINX_IMAGE'))),
  __API_IMAGE__: JSON.stringify(imageDigest('API_IMAGE', required('API_IMAGE'))),
  __WEB_ORIGIN__: JSON.stringify(webOrigins.join(',')),
  __SUPABASE_URL__: JSON.stringify(supabaseUrl.origin),
  __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(supabasePublishableKey),
  __DATABASE_SECRET__: JSON.stringify(resourceName('DATABASE_SECRET_NAME', required('DATABASE_SECRET_NAME'))),
  __DATABASE_SECRET_VERSION__: JSON.stringify(
    secretVersion('DATABASE_SECRET_VERSION', required('DATABASE_SECRET_VERSION')),
  ),
  __SUPABASE_SECRET_KEY_SECRET__: JSON.stringify(
    resourceName('SUPABASE_SECRET_KEY_SECRET_NAME', required('SUPABASE_SECRET_KEY_SECRET_NAME')),
  ),
  __SUPABASE_SECRET_KEY_SECRET_VERSION__: JSON.stringify(
    secretVersion(
      'SUPABASE_SECRET_KEY_SECRET_VERSION',
      required('SUPABASE_SECRET_KEY_SECRET_VERSION'),
    ),
  ),
  __SUPABASE_DB_CA_SECRET__: JSON.stringify(
    resourceName('SUPABASE_DB_CA_SECRET_NAME', required('SUPABASE_DB_CA_SECRET_NAME')),
  ),
  __SUPABASE_DB_CA_SECRET_VERSION__: JSON.stringify(
    secretVersion('SUPABASE_DB_CA_SECRET_VERSION', required('SUPABASE_DB_CA_SECRET_VERSION')),
  ),
};

let output = await readFile(templatePath, 'utf8');
for (const [placeholder, value] of Object.entries(values)) {
  output = output.replaceAll(placeholder, value);
}
if (/__[A-Z0-9_]+__/.test(output)) {
  throw new Error('The Cloud Run service template still contains unresolved placeholders');
}
process.stdout.write(output);
