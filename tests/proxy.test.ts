import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCache, type Cache } from '../src/cache.js';
import { readConfig } from '../src/config.js';
import { createProxy } from '../src/proxy.js';
import { parseRoute, redirectRoute } from '../src/routes.js';

const environment = { GITHUB_TOKEN: 'server-secret', GITHUB_ALLOWLIST: 'Alice, Vercel/Next.js,alice', CACHE_TTL_SECONDS: '30', CACHE_MAX_AGE_SECONDS: '120' };
const config = readConfig(environment);
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });
const request = (path = '/users/alice', init?: RequestInit) => new Request(`https://proxy.test${path}`, init);

function fixture(replies: Array<Response | Error | ((url: string, init?: RequestInit) => Promise<Response>)>, overrides: NodeJS.ProcessEnv = {}, external?: Cache) {
  let time = 1_800_000_000_000;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const logs: unknown[] = [];
  const cache = external ?? new MemoryCache(() => time);
  const handler = createProxy(readConfig({ ...environment, ...overrides }), {
    now: () => time, cache, log: event => logs.push(event),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      const reply = replies.shift();
      assert.ok(reply, `Unexpected upstream call: ${url}`);
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(url, init) : reply;
    }) as typeof fetch,
  });
  return { handler, calls, logs, cache, advance: (seconds: number) => { time += seconds * 1000; } };
}

test('allowlist supports complete owners and exact repositories, independently', () => {
  assert.equal(config.owners.size, 1);
  for (const path of ['/repos/ALICE/NewRepo', '/repos/alice/new-repo/issues', '/repos/VERCEL/Next.js/releases', '/users/ALICE', '/users/alice/repos']) assert.doesNotThrow(() => parseRoute(path, config));
  for (const path of ['/repos/alice2/test', '/repos/vercel/next.jsx', '/repos/vercel/other', '/users/vercel', '/users/vercel/repos']) assert.throws(() => parseRoute(path, config), /not allowed/);
  assert.throws(() => parseRoute('/users/alice', readConfig({ ...environment, GITHUB_ALLOWLIST: '' })), /not allowed/);
});

test('invalid configuration fails closed and fingerprint changes with access/cache/token config', () => {
  for (const value of ['alice/', '/repo', 'alice/repo/more', 'alice,,bob', '*', 'alice/..', 'alice /repo']) assert.throws(() => readConfig({ ...environment, GITHUB_ALLOWLIST: value }));
  for (const vars of [{ GITHUB_TOKEN: '' }, { CORS_ORIGINS: 'https://site.test/private' }]) assert.throws(() => readConfig({ ...environment, ...vars }));
  for (const vars of [{ GITHUB_ALLOWLIST: 'alice' }, { CACHE_TTL_SECONDS: '60' }, { CACHE_VERSION: '2' }, { GITHUB_TOKEN: 'new-secret' }]) assert.notEqual(config.prefix, readConfig({ ...environment, ...vars }).prefix);
  assert.equal(config.prefix, readConfig({ ...environment, GITHUB_ALLOWLIST: 'vercel/next.js,ALICE' }).prefix);
});

test('route whitelist rejects traversal, writes-only resources and arbitrary queries', () => {
  for (const path of ['/repos/alice/repo/../issues', '/repos/alice/%2e%2e', '/repos/alice/repo%2fother', '/repos/alice//issues', '/repos/alice/repo\\issues', '/user', '/search/repositories', '/repos/alice/repo/contents', '/repos/alice/repo/issues?random=1', '/repos/alice/repo/issues?page=1&page=2', '/users/alice/repos?per_page=101', '/users/alice/repos?page=0']) assert.throws(() => parseRoute(path, config), path);
  const route = parseRoute('/repos/Alice/Repo/issues?per_page=100&page=2&state=closed', config);
  assert.equal(route.query, 'page=2&per_page=100&state=closed');
  assert.equal(route.path, '/repos/alice/repo/issues');
});

test('redirects are restricted by host, route and destination allowlist', () => {
  const current = parseRoute('/repos/alice/repo', config);
  assert.equal(redirectRoute('https://api.github.com/repos/vercel/next.js', current, config).repository, 'vercel/next.js');
  for (const url of ['https://evil.test/repos/alice/repo', 'https://token@api.github.com/repos/alice/repo', 'http://api.github.com/repos/alice/repo', '/repos/bob/repo', '/repositories/123', '/repos/alice/repo/../other', '/repos/alice/%72epo', '/users/alice']) assert.throws(() => redirectRoute(url, current, config));
});

test('fresh hits avoid GitHub and CDN TTL is bounded by remaining freshness', async () => {
  const f = fixture([json({ login: 'alice' }, 200, { etag: '"one"' })]);
  const first = await f.handler(request());
  assert.equal(first.headers.get('x-proxy-cache'), 'MISS');
  assert.equal(first.headers.get('vercel-cdn-cache-control'), 'public, s-maxage=30, must-revalidate');
  f.advance(12);
  const second = await f.handler(request());
  assert.equal(second.headers.get('x-proxy-cache'), 'HIT');
  assert.match(second.headers.get('vercel-cdn-cache-control')!, /s-maxage=18,/);
  assert.deepEqual(await second.json(), { login: 'alice' });
  assert.equal(f.calls.length, 1);
});

test('ETag 304 reuses body and renews successful validation time', async () => {
  const f = fixture([json({ login: 'alice' }, 200, { etag: '"one"' }), new Response(null, { status: 304 })]);
  const first = await f.handler(request());
  f.advance(31);
  const second = await f.handler(request());
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { login: 'alice' });
  assert.equal(second.headers.get('x-proxy-cache'), 'REVALIDATED');
  assert.notEqual(second.headers.get('x-proxy-checked-at'), first.headers.get('x-proxy-checked-at'));
  assert.equal(new Headers(f.calls[1].init?.headers).get('if-none-match'), '"one"');
});

test('changed data replaces expired cache', async () => {
  const f = fixture([json({ n: 1 }), json({ n: 2 })]);
  await f.handler(request()); f.advance(31);
  assert.deepEqual(await (await f.handler(request())).json(), { n: 2 });
  assert.deepEqual(await (await f.handler(request())).json(), { n: 2 });
  assert.equal(f.calls.length, 2);
});

test('same-key concurrent requests collapse, different keys serialize', async () => {
  let active = 0; let peak = 0;
  const delayed = async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return json({ private: false });
  };
  const f = fixture([delayed, delayed]);
  const results = await Promise.all([...Array.from({ length: 20 }, () => f.handler(request())), f.handler(request('/repos/alice/repo'))]);
  assert.ok(results.every(r => r.status === 200));
  assert.equal(f.calls.length, 2); assert.equal(peak, 1);
});

test('503 and network errors serve bounded stale data without CDN caching', async () => {
  for (const error of [json({ message: 'unavailable' }, 503), new Error('network')]) {
    const f = fixture([json({ n: 1 }), error, new Error('network')]);
    await f.handler(request()); f.advance(31);
    const stale = await f.handler(request());
    assert.equal(stale.status, 200); assert.equal(stale.headers.get('x-proxy-cache'), 'STALE');
    assert.equal(stale.headers.get('vercel-cdn-cache-control'), 'no-store');
    f.advance(90);
    assert.equal((await f.handler(request())).status, 502);
  }
});

test('429 cooldown is shared across instances, resumes when Retry-After elapses', async () => {
  const f = fixture([json({ message: 'limited' }, 429, { 'retry-after': '60' }), json({ ok: true })]);
  const first = await f.handler(request());
  assert.equal(first.status, 429); assert.equal(first.headers.get('retry-after'), '60');
  assert.equal((await f.handler(request())).status, 429); assert.equal(f.calls.length, 1);
  const another = fixture([], {}, f.cache);
  assert.equal((await another.handler(request())).status, 429); assert.equal(another.calls.length, 0);
  f.advance(61); assert.equal((await f.handler(request())).status, 200);
});

test('primary rate limits honor reset and secondary errors have minimum backoff', async () => {
  const f = fixture([json({ message: 'rate limit' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000090' })]);
  const response = await f.handler(request());
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '90');
  const secondary = fixture([json({ message: 'secondary rate limit' }, 403)]);
  assert.equal((await secondary.handler(request())).headers.get('retry-after'), '60');
});

test('rate-limited refresh serves old data and avoids repeated upstream requests', async () => {
  const f = fixture([json({ n: 1 }), json({ message: 'limited' }, 429, { 'retry-after': '60' })]);
  await f.handler(request()); f.advance(31);
  const stale = await f.handler(request());
  assert.equal(stale.headers.get('x-proxy-cache'), 'STALE');
  assert.equal(stale.headers.get('retry-after'), '60');
  await f.handler(request()); assert.equal(f.calls.length, 2);
});

test('401/403/404 are not hidden by stale data, and invalidate the old entry', async () => {
  for (const status of [401, 403, 404]) {
    const f = fixture([json({ n: 1 }), json({ message: 'secret upstream details' }, status), new Error('offline')]);
    await f.handler(request()); f.advance(31);
    const denied = await f.handler(request());
    assert.equal(denied.status, status); assert.doesNotMatch(await denied.text(), /secret upstream details/);
    assert.equal((await f.handler(request())).status, 502);
  }
});

test('repository subresources verify public visibility before accessing content', async () => {
  const f = fixture([json({ private: false }), json([{ title: 'hello' }])]);
  assert.equal((await f.handler(request('/repos/alice/repo/issues'))).status, 200);
  assert.deepEqual(f.calls.map(c => new URL(c.url).pathname), ['/repos/alice/repo', '/repos/alice/repo/issues']);
  const denied = fixture([json({ private: true })]);
  assert.equal((await denied.handler(request('/repos/alice/private/issues'))).status, 403);
  assert.equal(denied.calls.length, 1);
});

test('redirected repository destination is authorized before forwarding credentials', async () => {
  const f = fixture([new Response(null, { status: 301, headers: { location: 'https://api.github.com/repos/other/repo' } })]);
  assert.equal((await f.handler(request('/repos/alice/repo'))).status, 403);
  assert.equal(f.calls.length, 1);
  const good = fixture([new Response(null, { status: 301, headers: { location: '/repos/vercel/next.js' } }), json({ private: false })]);
  assert.equal((await good.handler(request('/repos/alice/repo'))).status, 200);
  assert.equal(good.calls.length, 2);
});

test('private repository lists fail closed', async () => {
  const f = fixture([json([{ private: true, name: 'secret' }])]);
  const response = await f.handler(request('/users/alice/repos'));
  assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /secret/);
});

test('pagination links stay on proxy; client auth/cookies/accept are not forwarded', async () => {
  const f = fixture([json([], 200, { link: '<https://api.github.com/users/alice/repos?page=2>; rel="next", <https://evil.test/>; rel="last"' })]);
  const response = await f.handler(request('/users/alice/repos', { headers: { Authorization: 'Bearer client-secret', Cookie: 'session=secret', Accept: 'application/vnd.github.raw' } }));
  assert.equal(response.headers.get('link'), '</users/alice/repos?page=2>; rel="next"');
  const sent = new Headers(f.calls[0].init?.headers);
  assert.equal(sent.get('authorization'), 'Bearer server-secret'); assert.equal(sent.get('cookie'), null);
  assert.equal(sent.get('accept'), 'application/vnd.github+json');
  assert.doesNotMatch(JSON.stringify(f.logs) + JSON.stringify([...response.headers]) + await response.text(), /server-secret|client-secret/);
});

test('real GitHub user-ID pagination links are returned as named proxy URLs', async () => {
  const f = fixture([json([], 200, { link: '<https://api.github.com/user/123/repos?per_page=1&page=2>; rel="next"' })]);
  const response = await f.handler(request('/users/alice/repos?per_page=1'));
  assert.equal(response.headers.get('link'), '</users/alice/repos?page=2&per_page=1>; rel="next"');
});

test('repository tags support pagination, caching and repository authorization', async () => {
  const tags = [{ name: 'v1.0.0', commit: { sha: 'abc123', url: 'https://api.github.com/repos/alice/repo/commits/abc123' } }];
  const f = fixture([json({ private: false }), json(tags, 200, { link: '<https://api.github.com/repositories/123/tags?per_page=1&page=2>; rel="next"' })]);
  const response = await f.handler(request('/repos/alice/repo/tags?per_page=1&page=1'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), tags);
  assert.equal(response.headers.get('link'), '</repos/alice/repo/tags?page=2&per_page=1>; rel="next"');
  assert.equal((await f.handler(request('/repos/alice/repo/tags?page=1&per_page=1'))).headers.get('x-proxy-cache'), 'HIT');
  assert.equal((await f.handler(request('/repos/bob/repo/tags'))).status, 403);
  assert.equal((await f.handler(request('/repos/alice/repo/tags?per_page=101'))).status, 400);
  assert.equal((await f.handler(request('/repos/alice/repo/tags', { method: 'POST' }))).status, 405);
  assert.equal(f.calls.length, 2);
});

test('common public repository lists use the same visibility checks and cache', async () => {
  for (const suffix of ['stargazers', 'subscribers', 'forks', 'branches', 'commits', 'labels', 'milestones', 'pulls', 'issues/1/labels']) {
    const f = fixture([json({ private: false }), json([])]);
    const path = `/repos/alice/repo/${suffix}?per_page=1`;
    assert.equal((await f.handler(request(path))).status, 200, suffix);
    assert.equal((await f.handler(request(path))).headers.get('x-proxy-cache'), 'HIT');
    assert.equal((await f.handler(request(path, { method: 'POST' }))).status, 405);
    assert.equal((await f.handler(request(path.replace('/alice/', '/bob/')))).status, 403);
    assert.equal(f.calls.length, 2);
  }
  for (const suffix of ['languages', 'topics', 'pulls/1', 'milestones/1']) {
    const f = fixture([json({ private: false }), json({})]);
    assert.equal((await f.handler(request(`/repos/alice/repo/${suffix}`))).status, 200);
  }
});

test('new query parameters are validated for their specific endpoints', () => {
  for (const path of ['/repos/alice/repo/forks?sort=stargazers', '/repos/alice/repo/branches?protected=true', '/repos/alice/repo/pulls?sort=popularity&head=alice%3Afeature%2Ftest&state=all', '/repos/alice/repo/milestones?sort=completeness', '/repos/alice/repo/commits?sha=feature%2Ftest&path=src%2Findex.ts&until=2026-01-01T00%3A00%3A00Z']) assert.doesNotThrow(() => parseRoute(path, config));
  for (const path of ['/repos/alice/repo/stargazers?sort=created', '/repos/alice/repo/branches?protected=maybe', '/repos/alice/repo/commits?until=invalid', '/repos/alice/repo/forks?sort=updated', '/repos/alice/repo/milestones?sort=created', '/repos/alice/repo/traffic/views', '/repos/alice/repo/collaborators', '/repos/alice/repo/hooks']) assert.throws(() => parseRoute(path, config));
});

test('public user lists and organization endpoints require owner-level authorization', async () => {
  for (const suffix of ['followers', 'following', 'orgs', 'starred', 'subscriptions']) {
    const f = fixture([json([])]);
    assert.equal((await f.handler(request(`/users/alice/${suffix}?per_page=1`))).status, 200);
    assert.equal((await f.handler(request(`/users/vercel/${suffix}`))).status, 403);
  }
  const f = fixture([json({ login: 'alice' }), json([{ private: false }])]);
  assert.equal((await f.handler(request('/orgs/alice'))).status, 200);
  assert.equal((await f.handler(request('/orgs/alice/repos?per_page=1'))).status, 200);
  assert.equal(f.calls[1].url, 'https://api.github.com/orgs/alice/repos?per_page=1&type=public');
  assert.equal((await f.handler(request('/orgs/vercel/repos'))).status, 403);
  assert.equal((await f.handler(request('/orgs/alice/repos?type=private'))).status, 400);
});

test('new repository collections reject private data even with an overprivileged token', async () => {
  for (const path of ['/users/alice/starred', '/users/alice/subscriptions', '/orgs/alice/repos']) {
    const f = fixture([json([{ private: true }])]);
    assert.equal((await f.handler(request(path))).status, 403);
  }
  const f = fixture([json({ private: false }), json([{ private: true }])]);
  assert.equal((await f.handler(request('/repos/alice/repo/forks'))).status, 403);
});

test('methods and CORS are checked even when a cache entry exists', async () => {
  const f = fixture([json({ n: 1 })], { CORS_ORIGINS: 'https://site.test' });
  await f.handler(request());
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) assert.equal((await f.handler(request(undefined, { method }))).status, 405);
  assert.equal((await f.handler(request(undefined, { headers: { Origin: 'https://evil.test' } }))).status, 403);
  const good = await f.handler(request(undefined, { headers: { Origin: 'https://site.test' } }));
  assert.equal(good.headers.get('vary'), 'Origin'); assert.equal(good.headers.get('access-control-allow-origin'), 'https://site.test');
  const preflight = await f.handler(request(undefined, { method: 'OPTIONS', headers: { Origin: 'https://site.test', 'Access-Control-Request-Method': 'GET' } }));
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.equal(f.calls.length, 1);
});

test('cache failure retains bounded local fallback and logs no exception details', async () => {
  const broken: Cache = { get: async () => { throw new Error('server-secret'); }, set: async () => { throw new Error('server-secret'); }, delete: async () => {} };
  const f = fixture([json({ n: 1 })], {}, broken);
  assert.equal((await f.handler(request())).status, 200);
  assert.equal((await f.handler(request())).headers.get('x-proxy-cache'), 'HIT');
  assert.equal(f.calls.length, 1); assert.match(JSON.stringify(f.logs), /cache_degraded/); assert.doesNotMatch(JSON.stringify(f.logs), /server-secret/);
});

test('new allowlist/config cannot reuse old authorization cache', async () => {
  const f = fixture([json({ private: false })]);
  await f.handler(request('/repos/alice/repo'));
  const revoked = fixture([], { GITHUB_ALLOWLIST: 'vercel/next.js' }, f.cache);
  const response = await revoked.handler(request('/repos/alice/repo'));
  assert.equal(response.status, 403); assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.equal(revoked.calls.length, 0);
  const changed = fixture([json({ private: false, refreshed: true })], { CACHE_VERSION: '2' }, f.cache);
  assert.equal((await changed.handler(request('/repos/alice/repo'))).headers.get('x-proxy-cache'), 'MISS');
});

test('query ordering shares a cache entry and distinct pages remain separate', async () => {
  const f = fixture([json([]), json([])]);
  await f.handler(request('/users/alice/repos?per_page=10&page=1'));
  assert.equal((await f.handler(request('/users/alice/repos?page=1&per_page=10'))).headers.get('x-proxy-cache'), 'HIT');
  await f.handler(request('/users/alice/repos?page=2&per_page=10'));
  assert.equal(f.calls.length, 2);
});

test('non-JSON permission and rate-limit errors retain authoritative status', async () => {
  const f = fixture([new Response('Forbidden', { status: 403 })]);
  assert.equal((await f.handler(request())).status, 403);
  const limited = fixture([new Response('Too many requests', { status: 429, headers: { 'retry-after': '30' } })]);
  assert.equal((await limited.handler(request())).headers.get('retry-after'), '30');
});

test('a successful response that exhausts quota prevents the next upstream call', async () => {
  const f = fixture([json({ login: 'alice' }, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000060' })]);
  assert.equal((await f.handler(request())).status, 200);
  assert.equal((await f.handler(request('/users/alice/repos'))).status, 429);
  assert.equal(f.calls.length, 1);
});

test('public visibility guard stops a subrequest when metadata exhausts quota', async () => {
  const f = fixture([json({ private: false }, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000060' })]);
  assert.equal((await f.handler(request('/repos/alice/repo/issues'))).status, 429);
  assert.equal(f.calls.length, 1);
});

test('empty contributors remain a 204 response and can use runtime cache', async () => {
  const f = fixture([json({ private: false }), new Response(null, { status: 204 })]);
  const response = await f.handler(request('/repos/alice/empty/contributors'));
  assert.equal(response.status, 204); assert.equal(await response.text(), '');
  assert.equal((await f.handler(request('/repos/alice/empty/contributors'))).status, 204);
  assert.equal(f.calls.length, 2);
});

test('oversized and invalid success bodies are never cached', async () => {
  for (const body of ['x'.repeat(768 * 1024 + 1), 'not JSON']) {
    const f = fixture([new Response(body), json({ ok: true })]);
    assert.equal((await f.handler(request())).status, 502);
    assert.equal((await f.handler(request())).status, 200);
    assert.equal(f.calls.length, 2);
  }
});

test('fetch abort enforces configured timeout', async () => {
  const f = fixture([async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout did not abort upstream')), 1000);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
  })], { GITHUB_TIMEOUT_MS: '100' });
  const response = await f.handler(request());
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
});

test('memory cache honors TTL and capacity', async () => {
  let time = 0;
  const cache = new MemoryCache(() => time, 16);
  await cache.set('a', '12345678', 10);
  await cache.set('b', '12345678', 10);
  assert.equal(await cache.get('a'), undefined);
  assert.equal(await cache.get('b'), '12345678');
  time = 10000;
  assert.equal(await cache.get('b'), undefined);
});

test('discovery and quota preserve upstream JSON without opening other endpoints', async () => {
  const discovery = { current_user_url: 'https://api.github.com/user', rate_limit_url: 'https://api.github.com/rate_limit' };
  const quota = { resources: { core: { limit: 5000, remaining: 4999 } } };
  const f = fixture([json(discovery), json(quota)], { GITHUB_ALLOWLIST: '' });
  assert.deepEqual(await (await f.handler(request('/'))).json(), discovery);
  const response = await f.handler(request('/rate_limit', { headers: { Authorization: 'Bearer client-secret' } }));
  assert.deepEqual(await response.json(), quota);
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'public, s-maxage=5, must-revalidate');
  assert.equal(new Headers(f.calls[1].init?.headers).get('authorization'), 'Bearer server-secret');
  for (const path of ['/user', '/rate_limit/extra', '/rate_limit?page=1', '/?token=secret']) {
    assert.notEqual((await f.handler(request(path))).status, 200);
  }
  assert.equal((await f.handler(request('/', { method: 'POST' }))).status, 405);
  assert.equal(f.calls.length, 2);
});

test('quota cache expires after five seconds and never serves stale quota', async () => {
  const f = fixture([json({ rate: { remaining: 42 } }), json({ rate: { remaining: 41 } }), json({}, 503)]);
  await f.handler(request('/rate_limit'));
  f.advance(4);
  assert.equal((await f.handler(request('/rate_limit'))).headers.get('x-proxy-cache'), 'HIT');
  f.advance(1);
  assert.deepEqual(await (await f.handler(request('/rate_limit'))).json(), { rate: { remaining: 41 } });
  f.advance(5);
  const failed = await f.handler(request('/rate_limit'));
  assert.equal(failed.status, 502);
  assert.equal(failed.headers.get('vercel-cdn-cache-control'), 'no-store');
});

test('errors have a fixed envelope and distinguish local rejection from upstream failure', async () => {
  const cases = [
    { path: '/users/alice?unknown=1', status: 400, code: 'INVALID_REQUEST' },
    { path: '/users/bob', status: 403, code: 'FORBIDDEN' },
    { path: '/unsupported', status: 404, code: 'UNSUPPORTED_ENDPOINT' },
    { path: '/users/alice', method: 'POST', status: 405, code: 'METHOD_NOT_ALLOWED' },
    ...[401, 403, 404, 422].map(status => ({ path: '/users/alice', upstream: status, status, code: 'UPSTREAM_REQUEST_FAILED' })),
    { path: '/users/alice', upstream: 503, status: 502, code: 'UPSTREAM_ERROR' },
  ];
  for (const entry of cases) {
    const upstream = 'upstream' in entry ? entry.upstream : undefined;
    const f = fixture(upstream ? [json({ message: 'private upstream details' }, upstream)] : []);
    const response = await f.handler(request(entry.path, { method: 'method' in entry ? entry.method : 'GET' }));
    const body = await response.json();
    assert.equal(response.status, entry.status);
    assert.deepEqual(body, { success: false, code: entry.code, status: entry.status, message: body.message, details: null, retryAfter: null });
    assert.equal(typeof body.message, 'string');
    assert.doesNotMatch(body.message, /private upstream details/);
    assert.match(response.headers.get('content-type')!, /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  }
});

test('rate limit and cooldown expose retry seconds in the same error envelope', async () => {
  const f = fixture([json({}, 429, { 'retry-after': '60' })]);
  for (let i = 0; i < 2; i++) {
    const response = await f.handler(request());
    const body = await response.json();
    assert.deepEqual(body, { success: false, code: 'RATE_LIMITED', status: 429, message: body.message, details: null, retryAfter: 60 });
    assert.equal(response.headers.get('retry-after'), String(body.retryAfter));
  }
  assert.equal(f.calls.length, 1);
});

const lifetimePolicy = "The 'alice' organization forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days. Please adjust your token's lifetime at https://github.com/settings/personal-access-tokens/123";
const sentAuth = (call: { init?: RequestInit }) => new Headers(call.init?.headers).has('authorization');

test('PAT lifetime refusal falls back anonymously for visibility and content, caches and expires preference', async () => {
  const f = fixture([json({ message: lifetimePolicy }, 403), json({ private: false }), json([{ title: 'public' }]), json({ private: false }), json([]), json({ private: false }), json([])]);
  const path = '/repos/alice/repo/issues';
  const first = await f.handler(request(path));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), [{ title: 'public' }]);
  assert.deepEqual(f.calls.map(sentAuth), [true, false, false]);
  assert.equal((await f.handler(request(path))).headers.get('x-proxy-cache'), 'HIT');
  f.advance(31);
  assert.equal((await f.handler(request(path))).status, 200);
  assert.deepEqual(f.calls.slice(3).map(sentAuth), [false, false]);
  f.advance(300);
  assert.equal((await f.handler(request(path))).status, 200);
  assert.deepEqual(f.calls.slice(5).map(sentAuth), [true, true]);
  assert.match(JSON.stringify(f.logs), /github_anonymous_fallback/);
  assert.doesNotMatch(JSON.stringify(f.logs), /personal-access-tokens\/123|server-secret/);
});

test('anonymous preference is shared per repository and isolated by token', async () => {
  const f = fixture([json({ message: lifetimePolicy }, 403), json({ private: false })]);
  await f.handler(request('/repos/alice/repo'));
  const another = fixture([json([]), json({ private: false })], {}, f.cache);
  assert.equal((await another.handler(request('/repos/alice/repo/issues'))).status, 200);
  assert.equal((await another.handler(request('/repos/alice/other'))).status, 200);
  assert.deepEqual(another.calls.map(sentAuth), [false, true]);
  const rotated = fixture([json({ private: false })], { GITHUB_TOKEN: 'rotated' }, f.cache);
  assert.equal((await rotated.handler(request('/repos/alice/repo'))).status, 200);
  assert.equal(sentAuth(rotated.calls[0]), true);
});

test('only explicit repository lifetime-policy 403 can downgrade', async () => {
  for (const [status, message, headers] of [
    [401, lifetimePolicy, {}], [404, lifetimePolicy, {}], [403, 'Resource not accessible by personal access token', {}],
    [403, 'Organization requires SAML SSO', {}], [403, 'IP address is not allowed', {}],
    [403, lifetimePolicy, { 'retry-after': '60' }], [403, lifetimePolicy, { 'x-ratelimit-remaining': '0' }],
    [429, lifetimePolicy, {}], [403, 'secondary rate limit', {}],
  ] as Array<[number, string, Record<string, string>]>) {
    const f = fixture([json({ message }, status, headers)]);
    assert.notEqual((await f.handler(request('/repos/alice/repo'))).status, 200);
    assert.equal(f.calls.length, 1);
  }
  for (const path of ['/rate_limit', '/users/alice', '/orgs/alice']) {
    const f = fixture([json({ message: lifetimePolicy }, 403)]);
    assert.equal((await f.handler(request(path))).status, 403);
    assert.equal(f.calls.length, 1);
  }
});

test('failed anonymous retry never loops or remembers preference and preserves visibility guard', async () => {
  for (const reply of [json({ message: lifetimePolicy }, 403), json({}, 404), json({ private: true })]) {
    const f = fixture([json({ message: lifetimePolicy }, 403), reply, json({ private: false })]);
    assert.notEqual((await f.handler(request('/repos/alice/repo/issues'))).status, 200);
    assert.equal(f.calls.length, 2);
    assert.equal((await f.handler(request('/repos/alice/repo'))).status, 200);
    assert.equal(sentAuth(f.calls[2]), true);
  }
});

test('anonymous quota cooldown is shared but does not block token-backed repositories', async () => {
  const f = fixture([json({ message: lifetimePolicy }, 403), json({}, 429, { 'retry-after': '60' }), json({ private: false })]);
  assert.equal((await f.handler(request('/repos/alice/repo'))).status, 429);
  assert.equal((await f.handler(request('/repos/alice/other'))).status, 200);
  const another = fixture([json({ message: lifetimePolicy }, 403)], {}, f.cache);
  assert.equal((await another.handler(request('/repos/alice/repo'))).status, 429);
  assert.equal(another.calls.length, 1);
});

test('switching authentication drops ETag, while anonymous revalidation retains it', async () => {
  const f = fixture([json({ private: false }, 200, { etag: '"token"' }), json({ message: lifetimePolicy }, 403), json({ private: false }, 200, { etag: '"anon"' }), new Response(null, { status: 304 })]);
  await f.handler(request('/repos/alice/repo')); f.advance(31);
  assert.equal((await f.handler(request('/repos/alice/repo'))).status, 200);
  assert.equal(new Headers(f.calls[1].init?.headers).get('if-none-match'), '"token"');
  assert.equal(new Headers(f.calls[2].init?.headers).get('if-none-match'), null);
  f.advance(31);
  assert.equal((await f.handler(request('/repos/alice/repo'))).status, 200);
  assert.equal(new Headers(f.calls[3].init?.headers).get('if-none-match'), '"anon"');
});

test('anonymous fallback redirects remain anonymous and enforce destination allowlist', async () => {
  const f = fixture([json({ message: lifetimePolicy }, 403), new Response(null, { status: 301, headers: { location: '/repos/vercel/next.js' } }), json({ private: false })]);
  assert.equal((await f.handler(request('/repos/alice/repo'))).status, 200);
  assert.deepEqual(f.calls.map(sentAuth), [true, false, false]);
  const denied = fixture([json({ message: lifetimePolicy }, 403), new Response(null, { status: 301, headers: { location: 'https://evil.test/repos/alice/repo' } })]);
  assert.equal((await denied.handler(request('/repos/alice/repo'))).status, 502);
  assert.equal(denied.calls.length, 2);
});

test('content-only policy refusal supports 204 and shares preference with other subresources', async () => {
  const f = fixture([json({ private: false }), json({ message: lifetimePolicy }, 403), new Response(null, { status: 204 }), json([])]);
  assert.equal((await f.handler(request('/repos/alice/repo/contributors'))).status, 204);
  assert.equal((await f.handler(request('/repos/alice/repo/issues'))).status, 200);
  assert.deepEqual(f.calls.map(sentAuth), [true, true, false, false]);
});

test('anonymous metadata exhausting quota prevents content fetch but leaves token quota alone', async () => {
  const f = fixture([json({ message: lifetimePolicy }, 403), json({ private: false }, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000060' }), json({ private: false })]);
  assert.equal((await f.handler(request('/repos/alice/repo/issues'))).status, 429);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.handler(request('/repos/alice/other'))).status, 200);
});
