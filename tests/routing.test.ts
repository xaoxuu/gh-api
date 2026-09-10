import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MemoryCache } from '../src/cache.js';
import { readConfig } from '../src/config.js';
import { createProxy } from '../src/proxy.js';
import { paginationRoute, parseRoute } from '../src/routes.js';

const deployment = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

test('deployment routes use no captures that could become GitHub query parameters', () => {
  assert.equal(deployment.rewrites, undefined);
  const route = deployment.routes.find((item: { dest?: string }) => item.dest === '/api/index');
  assert.ok(route);
  const matcher = new RegExp(route.src);
  for (const path of ['/', '/rate_limit', '/users/xaoxuu', '/users/xaoxuu/repos', '/repos/xaoxuu/repo/issues', '/orgs/xaoxuu/repos']) {
    const match = matcher.exec(path);
    assert.ok(match);
    assert.equal(match.length, 1, 'Routing must not capture path components as parameters');
  }
  for (const path of ['/users-other/xaoxuu', '/repos-other/test', '/robots.txt']) assert.equal(matcher.test(path), false);
  assert.deepEqual(deployment.routes.at(-1), { handle: 'filesystem' });
});

test('new numeric pagination links retain their authorized owner and resource', () => {
  const config = readConfig({ GITHUB_TOKEN: 'test-token', GITHUB_ALLOWLIST: 'alice' });
  for (const [path, link] of [
    ['/users/alice/followers', 'https://api.github.com/user/123/followers?page=2'],
    ['/users/alice/starred', 'https://api.github.com/user/123/starred?page=2'],
    ['/orgs/alice/repos', 'https://api.github.com/organizations/123/repos?page=2'],
    ['/repos/alice/repo/stargazers', 'https://api.github.com/repositories/123/stargazers?page=2'],
  ]) {
    const next = paginationRoute(link, parseRoute(path, config), config);
    assert.equal(next.path, path);
    assert.equal(new URLSearchParams(next.query).get('page'), '2');
  }
});

test('GitHub numeric pagination links retain authorized named routes and encoded filters', () => {
  const config = readConfig({ GITHUB_TOKEN: 'test-token', GITHUB_ALLOWLIST: 'xaoxuu' });
  const user = parseRoute('/users/xaoxuu/repos?per_page=1', config);
  const next = paginationRoute('https://api.github.com/user/16400144/repos?per_page=1&page=2', user, config);
  assert.equal(next.path, '/users/xaoxuu/repos');
  assert.equal(next.query, 'page=2&per_page=1');
  const issues = parseRoute('/repos/xaoxuu/repo/issues', config);
  const filtered = paginationRoute('https://api.github.com/repositories/123/issues?labels=bug%2Chelp&page=2', issues, config);
  assert.equal(filtered.path, '/repos/xaoxuu/repo/issues');
  assert.equal(filtered.query, 'labels=bug%2Chelp&page=2');
  for (const link of ['https://evil.test/user/123/repos?page=2', 'https://api.github.com/user/123/repos?page=2&token=secret', 'https://api.github.com/user/123/starred?page=2']) {
    assert.throws(() => paginationRoute(link, user, config));
  }
});

test('root profile and paginated requests forward only supported explicit query parameters', async () => {
  const calls: string[] = [];
  const handler = createProxy(readConfig({ GITHUB_TOKEN: 'test-token', GITHUB_ALLOWLIST: 'xaoxuu' }), {
    cache: new MemoryCache(), log: () => {},
    fetch: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json(String(input).includes('/repos') ? [] : { login: 'xaoxuu' });
    }) as typeof fetch,
  });
  const get = (path: string) => handler(new Request(`https://proxy.test${path}`));
  assert.equal((await get('/users/xaoxuu')).status, 200);
  assert.equal((await get('/users/xaoxuu/repos?per_page=20&page=2')).status, 200);
  assert.deepEqual(calls, ['https://api.github.com/users/xaoxuu', 'https://api.github.com/users/xaoxuu/repos?page=2&per_page=20']);
  const unsupported = await get('/users/xaoxuu?path=xaoxuu');
  assert.equal(unsupported.status, 400);
  assert.deepEqual(await unsupported.json(), {
    success: false, code: 'INVALID_REQUEST', status: 400,
    message: 'Unsupported query parameter: path', details: null, retryAfter: null,
  });
  const duplicate = await get('/users/xaoxuu/repos?page=1&page=2');
  assert.equal(duplicate.status, 400);
  assert.deepEqual(await duplicate.json(), {
    success: false, code: 'INVALID_REQUEST', status: 400,
    message: 'Duplicate query parameter: page', details: null, retryAfter: null,
  });
  assert.equal(calls.length, 2);
});

test('supported filters expand without relaxing endpoint or public-only parameter rules', () => {
  const config = readConfig({ GITHUB_TOKEN: 'test-token', GITHUB_ALLOWLIST: 'xaoxuu' });
  for (const [path, query] of [
    ['/repos/xaoxuu/repo/forks', 'sort=watchers'],
    ['/repos/xaoxuu/repo/topics', 'page=1&per_page=20'],
    ['/repos/xaoxuu/repo/issues', 'issue_field_values=priority%3AUrgent&type=Bug'],
  ]) assert.equal(parseRoute(`${path}?${query}`, config).query, query);
  for (const path of ['/orgs/xaoxuu/repos?type=private', '/repos/xaoxuu/repo/issues?unknown=1', '/repos/xaoxuu/repo/hooks', '/repos/xaoxuu/repo/contributors?direction=up']) {
    assert.throws(() => parseRoute(path, config), path);
  }
  const route = parseRoute('/repos/xaoxuu/repo/issues?type=Bug', config);
  assert.equal(paginationRoute('https://api.github.com/repositories/123/issues?type=Bug&page=02', route, config).query, 'page=2&type=Bug');
});

test('noise is removed consistently and pagination canonicalizes without weakening input bounds', () => {
  const config = readConfig({ GITHUB_TOKEN: 'test-token', GITHUB_ALLOWLIST: 'xaoxuu' });
  for (const path of ['/', '/rate_limit', '/users/xaoxuu']) {
    assert.deepEqual(parseRoute(`${path}?_=1&timestamp=2`, config), parseRoute(path, config));
    for (const query of ['_=1&_=2', 'timestamp=%00', 'unknown=1', 'token=secret']) {
      assert.throws(() => parseRoute(`${path}?${query}`, config), query);
    }
  }
  assert.equal(parseRoute('/users/xaoxuu/repos?page=01&per_page=020&_=1', config).query, 'page=1&per_page=20');
  for (const query of ['page=00', 'page=-1', 'page=1.0', 'per_page=0101', 'page=10001', 'page=1&page=01']) {
    assert.throws(() => parseRoute(`/users/xaoxuu/repos?${query}`, config), query);
  }
});
