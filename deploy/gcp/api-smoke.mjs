#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const local = resolve(root, 'deploy/gcp/.local');
const source = dotenv.parse(readFileSync(resolve(root, '.env')));
const setup = dotenv.parse(readFileSync(resolve(root, 'deploy/gcp/setup.local.env')));
const image = process.argv[2] || 'superkalan-api:prepared-20261008';
const container = `superkalan-api-smoke-${process.pid}`;
const ca = resolve(local, 'supabase-ca.crt');
const envFile = resolve(local, 'api-runtime.env');
const env = {
  NODE_ENV: 'production', PORT: '3001', WEB_ORIGIN: source.WEB_ORIGIN || 'http://localhost:3000',
  DATABASE_URL: source.DATABASE_URL, DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'true', DATABASE_SSL_CA_CERT_PATH: '/var/run/secrets/supabase/root.crt',
  DATABASE_RESOLVE_POOLER_IPV4: 'false', SUPABASE_URL: source.SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: setup.SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: source.SUPABASE_SECRET_KEY || source.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_JWT_SECRET: source.SUPABASE_JWT_SECRET,
  DELIVERY_RIDER_MOBILE_VERIFICATION_MODE: 'sms',
};
for (const [name, value] of Object.entries(env)) {
  if (!value || /[\r\n]/.test(value)) throw new Error(`Missing or multiline input: ${name}`);
}
writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
chmodSync(ca, 0o644); // Public trust certificate, readable by the non-root API user.
function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
}
let started = false;
try {
  docker(['run', '-d', '--name', container, '--platform=linux/amd64', '--memory=1g', '--cpus=1', '--env-file', envFile, '-v', `${ca}:/var/run/secrets/supabase/root.crt:ro`, '-p', '127.0.0.1:13001:3001', image]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:13001/api/health/ready', { signal: AbortSignal.timeout(3000) });
      if (response.status === 200 && (await response.json()).status === 'ready') { ready = true; break; }
    } catch { /* Wait for startup and the verified database connection. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('Production container did not become database-ready');
  for (const [path, status, headers] of [
    ['/api/health/live', 200, {}],
    ['/api/branches', 401, {}],
    ['/api/users', 401, { Authorization: 'Bearer deliberately-invalid-smoke-token' }],
  ]) {
    const response = await fetch(`http://127.0.0.1:13001${path}`, { headers, signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    if (response.status !== status) throw new Error(`${path}: expected ${status}, received ${response.status}`);
    console.log(`${path}: HTTP ${status}`);
  }
  console.log('Production container verified with live Supabase, bounded memory/CPU, and rejected unauthenticated/invalid-token requests.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Smoke test failed');
  if (started) {
    let log = docker(['logs', '--tail', '15', container]);
    for (const value of Object.values(source)) if (value?.length > 4) log = log.replaceAll(value, '[redacted]');
    console.error(log);
  }
  process.exitCode = 1;
} finally {
  if (started) docker(['rm', '-f', container]);
}
