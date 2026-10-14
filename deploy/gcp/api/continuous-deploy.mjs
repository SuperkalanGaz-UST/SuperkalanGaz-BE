import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const project = 'traccar-510507';
const region = 'asia-southeast1';
const service = 'superkalan-crm-api';
const registry = `${region}-docker.pkg.dev/${project}/superkalan-crm`;
export const cutoff = '2026-12-19T16:00:00Z'; // Dec 20, 00:00 Asia/Manila.

export function checkWindow(now = Date.now()) {
  if (now >= Date.parse(cutoff)) throw new Error('The approved funded deployment window has ended.');
}

function execute(args) {
  // Global flags must precede --container, which starts container-scoped parsing.
  return execFileSync('gcloud', ['--quiet', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000,
  }).trim();
}

export async function release({ env = process.env, run = execute, request = fetch, now = Date.now } = {}) {
  checkWindow(now());
  if (env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) {
    throw new Error('Only a full main-branch commit can be released.');
  }
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) {
    throw new Error('GitHub run identity is required.');
  }
  const scope = [`--project=${project}`, `--region=${region}`];
  const describe = () => JSON.parse(run(['run', 'services', 'describe', service, ...scope, '--format=json']));
  const before = describe();
  const traffic = before.status.traffic.filter((entry) => entry.percent > 0);
  if (traffic.length !== 1 || traffic[0].percent !== 100 || !traffic[0].revisionName) {
    throw new Error('Expected one healthy production revision with 100% traffic.');
  }
  const previous = traffic[0].revisionName;
  const suffix = `gh-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const revision = `${service}-${suffix}`;
  const tag = 'github-candidate';
  const images = ['api', 'api-nginx'].map((image) => {
    const digest = run(['artifacts', 'docker', 'images', 'describe', `${registry}/${image}:${env.GITHUB_SHA}`,
      `--project=${project}`, '--format=value(image_summary.digest)']);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Image digest could not be verified.');
    return `${registry}/${image}@${digest}`;
  });
  // An image-only update preserves the existing runtime identity, secrets, VPC,
  // probes, resource limits and NGINX/API relationship. No migration is executed.
  checkWindow(now());
  run(['run', 'services', 'update', service, ...scope, '--no-traffic', `--tag=${tag}`,
    `--revision-suffix=${suffix}`, '--container=api', `--image=${images[0]}`,
    '--container=nginx', `--image=${images[1]}`]);
  const candidate = describe().status.traffic.find((entry) => entry.tag === tag && entry.revisionName === revision);
  if (!candidate?.url || !/^https:\/\/[a-z0-9.-]+\.run\.app$/.test(candidate.url)) {
    throw new Error('The candidate URL could not be verified; production traffic was not promoted.');
  }
  for (const [path, expected, headers] of [
    ['/api/health/live', 200, {}], ['/api/health/ready', 200, {}],
    ['/api/branches', 401, {}], ['/api/users', 401, { Authorization: 'Bearer invalid' }],
  ]) {
    const response = await request(`${candidate.url}${path}`, {
      headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    await response.arrayBuffer();
    if (response.status !== expected) throw new Error(`Candidate ${path}: expected ${expected}, received ${response.status}; production traffic was not promoted.`);
  }
  checkWindow(now());
  run(['run', 'services', 'update-traffic', service, ...scope, `--to-revisions=${revision}=100`, `--remove-tags=${tag}`]);
  const after = describe();
  if (!after.status.traffic.some((entry) => entry.revisionName === revision && entry.percent === 100)) {
    throw new Error(`Traffic promotion could not be confirmed. Inspect the service; prior revision: ${previous}`);
  }
  const summary = `Deployed ${env.GITHUB_SHA}\n\nURL: ${after.status.url}\n\nRevision: ${revision}\n\nPrevious revision: ${previous}\n`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  return { revision, previous, url: after.status.url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--check-window') checkWindow();
    else console.log(await release());
  } catch (error) {
    // Gcloud captures service configuration internally; never echo its stdout or
    // raw error object because runtime configuration can contain secret material.
    console.error(error instanceof Error ? error.message : 'Deployment failed.');
    process.exitCode = 1;
  }
}
