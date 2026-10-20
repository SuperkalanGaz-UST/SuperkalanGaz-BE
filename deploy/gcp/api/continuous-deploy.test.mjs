import assert from 'node:assert/strict';
import test from 'node:test';
import { checkWindow, cutoff, release } from './continuous-deploy.mjs';

function fixture(status = 200) {
  const calls = [];
  const requests = [];
  const env = { GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  const revision = 'superkalan-crm-api-gh-123-1';
  let reads = 0;
  const run = (args) => {
    calls.push(args);
    if (args.includes('images')) return `sha256:${'b'.repeat(64)}`;
    if (args.includes('describe')) {
      reads++;
      const traffic = reads === 1 ? [{ revisionName: 'previous', percent: 100 }]
        : reads === 2 ? [{ revisionName: 'previous', percent: 100 }, { revisionName: revision, tag: 'github-candidate', url: 'https://candidate.run.app' }]
          : [{ revisionName: revision, percent: 100 }];
      return JSON.stringify({ status: { traffic, url: 'https://production.run.app' } });
    }
    return '';
  };
  const request = async (url, options) => {
    requests.push([url, options]);
    const publicRead = url.includes('/health/') || url.endsWith('/api/prices/regions') || url.includes('/api/prices?');
    return new Response('', { status: publicRead ? status : 401 });
  };
  return { env, run, request, now: () => Date.parse('2026-10-14T00:00:00Z'), calls, requests };
}

test('verifies the no-traffic candidate before promoting digest-pinned images', async () => {
  const f = fixture();
  const result = await release(f);
  assert.equal(result.previous, 'previous');
  assert.equal(f.requests.length, 9);
  const update = f.calls.find((args) => args.includes('update'));
  assert.ok(update.includes('--no-traffic'));
  assert.equal(update.filter((arg) => arg.startsWith('--image=')).length, 2);
  assert.ok(update.filter((arg) => arg.startsWith('--image=')).every((arg) => arg.includes('@sha256:')));
  assert.ok(!update.some((arg) => /env-vars|secrets|service-account|network|volume/.test(arg)));
  assert.ok(f.calls.some((args) => args.includes('update-traffic')));
});

test('a failing candidate never receives production traffic', async () => {
  const f = fixture(503);
  await assert.rejects(release(f), /production traffic was not promoted/);
  assert.ok(!f.calls.some((args) => args.includes('update-traffic')));
});

test('candidate authentication regression prevents promotion', async () => {
  const f = fixture();
  f.request = async () => new Response('', { status: 200 });
  await assert.rejects(release(f), /expected 401/);
  assert.ok(!f.calls.some((args) => args.includes('update-traffic')));
});

test('non-main refs cannot modify cloud resources', async () => {
  const f = fixture();
  f.env.GITHUB_REF = 'refs/heads/develop';
  await assert.rejects(release(f), /main-branch/);
  assert.equal(f.calls.length, 0);
});

test('funded-window cutoff blocks releases at the Manila stop time', () => {
  checkWindow(Date.parse(cutoff) - 1);
  assert.throws(() => checkWindow(Date.parse(cutoff)), /ended/);
});

test('a cutoff reached during verification prevents promotion', async () => {
  const f = fixture();
  let checks = 0;
  f.now = () => ++checks < 3 ? Date.parse(cutoff) - 1 : Date.parse(cutoff);
  await assert.rejects(release(f), /ended/);
  assert.ok(!f.calls.some((args) => args.includes('update-traffic')));
});

test('a candidate missing the regional pricing endpoint cannot receive traffic', async () => {
  const f = fixture();
  const request = f.request;
  f.request = async (url, options) => url.endsWith('/api/prices/regions')
    ? new Response(JSON.stringify({ message: 'Cannot GET /api/prices/regions' }), { status: 404 })
    : request(url, options);
  await assert.rejects(release(f), /prices\/regions: expected 200, received 404/);
  assert.ok(!f.calls.some((args) => args.includes('update-traffic')));
});

for (const path of ['/api/salary-expenses', '/api/salary-expenses/staff']) {
  test(`a candidate missing ${path} cannot receive production traffic`, async () => {
    const f = fixture();
    const request = f.request;
    f.request = async (url, options) => url.endsWith(path)
      ? new Response(JSON.stringify({ message: `Cannot GET ${path}` }), { status: 404 })
      : request(url, options);
    await assert.rejects(release(f), /salary-expenses.*expected 401, received 404/);
    assert.ok(!f.calls.some((args) => args.includes('update-traffic')));
  });
}
