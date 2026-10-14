#!/usr/bin/env node
// Scope all changes to this release's backup bucket and custom uploader role.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';

const cli = process.env.GCLOUD_BIN || '/Users/claireantonetteabas/google-cloud-sdk/bin/gcloud';
const project = 'traccar-510507';
const bucket = 'gs://superkalan-traccar-backups-traccar-510507';
const roleId = 'superkalanBackupUploader';
const roleName = `projects/${project}/roles/${roleId}`;
const member = `serviceAccount:superkalan-traccar@${project}.iam.gserviceaccount.com`;
const permissions = ['storage.objects.create', 'storage.objects.get', 'storage.objects.list'];
function run(args, optional = false) {
  try { return execFileSync(cli, [...args, `--project=${project}`, '--quiet'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }).trim(); }
  catch { if (optional) return null; throw new Error(`gcloud ${args.slice(0, 3).join(' ')} failed`); }
}
try {
  const setup = dotenv.parse(readFileSync('deploy/gcp/setup.local.env'));
  if (setup.GCP_IMPLEMENTATION_AUTHORIZATION !== 'OWNER_REQUEST_2026_10_08') throw new Error('Deployment authorization missing');
  if (!run(['storage', 'buckets', 'describe', bucket, '--format=json'], true)) {
    run(['storage', 'buckets', 'create', bucket, '--location=asia-southeast1', '--default-storage-class=STANDARD', '--uniform-bucket-level-access', '--public-access-prevention']);
  }
  const metadata = JSON.parse(run(['storage', 'buckets', 'describe', bucket, '--format=json']));
  if (metadata.location !== 'ASIA-SOUTHEAST1' || metadata.default_storage_class !== 'STANDARD') throw new Error('Unexpected backup bucket location/class');
  run(['storage', 'buckets', 'update', bucket, '--lifecycle-file=deploy/gcp/backup-lifecycle.json', '--public-access-prevention', '--uniform-bucket-level-access']);
  const existing = run(['iam', 'roles', 'describe', roleId, '--format=json'], true);
  if (existing) {
    const value = JSON.parse(existing);
    if (value.deleted || value.includedPermissions?.some(p => !permissions.includes(p))) throw new Error('Unexpected custom role; review before changing it');
  }
  run(['iam', 'roles', existing ? 'update' : 'create', roleId, '--title=Superkalan protected backup uploader', '--description=Bucket-scoped gcloud backup upload: create, get and destination listing; no delete or overwrite.', `--permissions=${permissions.join(',')}`, '--stage=GA']);
  run(['storage', 'buckets', 'add-iam-policy-binding', bucket, `--member=${member}`, `--role=${roleName}`]);
  const policy = JSON.parse(run(['storage', 'buckets', 'get-iam-policy', bucket, '--format=json']));
  if (policy.bindings?.some(b => b.role === 'roles/storage.objectCreator' && b.members.includes(member))) {
    run(['storage', 'buckets', 'remove-iam-policy-binding', bucket, `--member=${member}`, '--role=roles/storage.objectCreator']);
  }
  console.log('Private Singapore backup bucket ready; uploader has create/get/list, no delete; daily-only retention configured.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
