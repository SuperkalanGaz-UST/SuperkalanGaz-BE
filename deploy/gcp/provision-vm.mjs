#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import dotenv from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = process.env.GCLOUD_BIN || '/Users/claireantonetteabas/google-cloud-sdk/bin/gcloud';
const project = 'traccar-510507', region = 'asia-southeast1', zone = 'asia-southeast1-b';
const vm = 'superkalan-traccar';
const setup = dotenv.parse(readFileSync(resolve(root, 'deploy/gcp/setup.local.env')));
function run(args) {
  return execFileSync(cli, [...args, '--quiet'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }).trim();
}
try {
  if (process.argv[2] !== '--create') throw new Error('Use --create only for the authorized infrastructure rollout');
  if (run(['config', 'get-value', 'project']) !== project || setup.GCP_BUDGET_ALERTS_STATUS !== 'CREATED_GROSS_USAGE_150_USD' || setup.GCP_NETWORK_REVIEW_REQUIRED !== 'NO' || setup.GCP_IMPLEMENTATION_AUTHORIZATION !== 'OWNER_REQUEST_2026_10_08') throw new Error('Preparation record is incomplete');
  const existing = JSON.parse(run(['compute', 'instances', 'list', `--project=${project}`, `--filter=name=${vm}`, '--format=json']));
  if (existing.length) throw new Error('Named VM already exists; inspect it rather than overwriting');
  const addresses = JSON.parse(run(['compute', 'addresses', 'list', `--project=${project}`, `--filter=name=${vm}-ip`, '--format=json']));
  if (!addresses.length) run(['compute', 'addresses', 'create', `${vm}-ip`, `--project=${project}`, `--region=${region}`, '--network-tier=PREMIUM']);
  const address = JSON.parse(run(['compute', 'addresses', 'describe', `${vm}-ip`, `--project=${project}`, `--region=${region}`, '--format=json']));
  if (address.status !== 'RESERVED') throw new Error('Static address is already in use');
  run(['compute', 'instances', 'create', vm, `--project=${project}`, `--zone=${zone}`, '--machine-type=e2-small', '--image-family=ubuntu-2404-lts-amd64', '--image-project=ubuntu-os-cloud', '--boot-disk-size=30GB', '--boot-disk-type=pd-balanced', '--no-boot-disk-auto-delete', '--subnet=superkalan-vm-sg', '--private-network-ip=10.60.0.10', `--address=${address.address}`, '--network-tier=PREMIUM', '--tags=superkalan-traccar', `--service-account=superkalan-traccar@${project}.iam.gserviceaccount.com`, '--scopes=https://www.googleapis.com/auth/devstorage.read_write', '--metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE', `--metadata-from-file=startup-script=${resolve(root, 'deploy/gcp/vm-bootstrap.sh')}`, '--shielded-secure-boot', '--shielded-vtpm', '--shielded-integrity-monitoring', '--labels=application=superkalan,environment=capstone,credit-cutoff=2026-12-20']);
  const result = JSON.parse(run(['compute', 'instances', 'describe', vm, `--project=${project}`, `--zone=${zone}`, '--format=json']));
  writeFileSync(resolve(root, 'deploy/gcp/.local/vm-release.json'), JSON.stringify({ name: vm, zone, privateIp: result.networkInterfaces[0].networkIP, publicIp: address.address, machine: 'e2-small', diskGiB: 30, status: result.status, cutoff: '2026-12-20' }, null, 2) + '\n', { mode: 0o600 });
  console.log('Traccar VM created:', vm, result.status);
  console.log('Device destination:', address.address + ':5013');
  console.log('Private API:', 'https://10.60.0.10');
  console.log('Wait for bootstrap-ready and install the verified stack over IAP.');
} catch (error) {
  console.error(error.stderr?.toString().slice(0, 1800) || error.message);
  process.exitCode = 1;
}
