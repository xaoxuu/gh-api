import assert from 'node:assert/strict';

const base = new URL(process.argv[2]);
assert.equal(base.protocol, 'https:');
async function get(path, init) {
  const headers = new Headers(init?.headers);
  if (process.env.SMOKE_BYPASS_SECRET) headers.set('x-vercel-protection-bypass', process.env.SMOKE_BYPASS_SECRET);
  const response = await fetch(new URL(path, base), { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  console.log(JSON.stringify({ path, status: response.status, cache: response.headers.get('x-vercel-cache'), proxyCache: response.headers.get('x-proxy-cache') }));
  return response;
}
const profile = await get('/users/xaoxuu');
assert.equal(profile.status, 200, 'Profile request failed');
assert.match(profile.headers.get('content-type') ?? '', /application\/json/);
assert.equal((await profile.json()).login.toLowerCase(), 'xaoxuu');
const cached = await get('/users/xaoxuu');
assert.equal(cached.status, 200);
assert.equal(cached.headers.get('x-vercel-cache'), 'HIT');
const repos = await get('/users/xaoxuu/repos?per_page=1&page=1');
assert.equal(repos.status, 200);
assert.ok(Array.isArray(await repos.json()));
assert.match(repos.headers.get('link') ?? '', /<\/users\/xaoxuu\/repos\?/);
const next = repos.headers.get('link').match(/<([^>]+)>; rel="next"/);
assert.ok(next);
assert.equal((await get(next[1])).status, 200);
const tags = await get('/repos/xaoxuu/hexo-theme-stellar/tags?per_page=1&page=1');
assert.equal(tags.status, 200);
assert.ok(Array.isArray(await tags.json()));
assert.match(tags.headers.get('link') ?? '', /<\/repos\/xaoxuu\/hexo-theme-stellar\/tags\?/);
for (const resource of ['stargazers', 'subscribers', 'forks', 'branches', 'commits', 'labels', 'milestones', 'pulls']) {
  const response = await get(`/repos/xaoxuu/hexo-theme-stellar/${resource}?per_page=1`);
  assert.equal(response.status, 200, `${resource} request failed`);
  assert.ok(Array.isArray(await response.json()));
  if (resource === 'stargazers') assert.match(response.headers.get('link') ?? '', /\/stargazers\?/);
}
for (const resource of ['languages', 'topics']) {
  const response = await get(`/repos/xaoxuu/hexo-theme-stellar/${resource}`);
  assert.equal(response.status, 200);
  assert.equal(typeof await response.json(), 'object');
}
for (const resource of ['followers', 'following', 'orgs', 'starred', 'subscriptions']) {
  const response = await get(`/users/xaoxuu/${resource}?per_page=1`);
  assert.equal(response.status, 200, `${resource} request failed`);
  assert.ok(Array.isArray(await response.json()));
}
const options = await get('/users/xaoxuu', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET' } });
assert.equal(options.status, 204);
assert.equal(options.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
assert.equal((await get('/users/gh-api-denied-smoke-test')).status, 403);
assert.equal((await get('/users/xaoxuu', { method: 'POST' })).status, 405);
console.log('Deployment smoke checks passed');
