import assert from 'node:assert/strict';
import { test } from 'node:test';
import api from '../api/index.js';
import { ConfigurationError, readConfig } from '../src/config.js';

test('configuration errors identify invalid fields without exposing their values', () => {
  const cases = [
    ['GITHUB_TOKEN', 'secret token'],
    ['GITHUB_ALLOWLIST', 'secret/repo/extra'],
    ['CORS_ORIGINS', 'https://secret.test/path'],
  ];
  for (const [field, value] of cases) {
    assert.throws(() => readConfig({ GITHUB_TOKEN: 'test-token', [field]: value }), error => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.field, field);
      assert.doesNotMatch(error.message, /secret|test-token/);
      return true;
    });
  }
});

test('API reports an actionable missing-token error in response and logs', async () => {
  const previous = process.env.GITHUB_TOKEN;
  const originalLog = console.error;
  const logs: string[] = [];
  try {
    delete process.env.GITHUB_TOKEN;
    console.error = (message: string) => { logs.push(message); };
    const response = await api.fetch(new Request('https://proxy.test/users/xaoxuu'));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.code, 'INVALID_CONFIGURATION');
    assert.equal(body.success, false);
    assert.equal(body.status, 500);
    assert.equal(body.retryAfter, null);
    assert.equal(body.details.field, 'GITHUB_TOKEN');
    assert.match(body.details.reason, /redeploy/);
    assert.equal(JSON.parse(logs[0]).field, 'GITHUB_TOKEN');
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
    console.error = originalLog;
  }
});


test('optional numeric settings fall back for empty, malformed and out-of-range values', () => {
  for (const value of ['', '   ', 'undefined', 'null', 'NaN', '-1', '0', '1.5', '999999999999999999999']) {
    const config = readConfig({ GITHUB_TOKEN: 'test-token', CACHE_TTL_SECONDS: value, CACHE_MAX_AGE_SECONDS: value, GITHUB_TIMEOUT_MS: value });
    assert.equal(config.ttl, 1800);
    assert.equal(config.maxAge, 86400);
    assert.equal(config.timeout, 10000);
  }
});

test('stale age below configured freshness falls back without failing startup', () => {
  const config = readConfig({ GITHUB_TOKEN: 'test-token', CACHE_TTL_SECONDS: '3600', CACHE_MAX_AGE_SECONDS: '1800' });
  assert.equal(config.ttl, 3600);
  assert.equal(config.maxAge, 86400);
});

test('valid trimmed settings are preserved and maximum age always covers freshness', () => {
  const config = readConfig({ GITHUB_TOKEN: 'test-token', CACHE_TTL_SECONDS: ' 3600 ', CACHE_MAX_AGE_SECONDS: ' 7200 ', GITHUB_TIMEOUT_MS: ' 5000 ' });
  assert.equal(config.ttl, 3600);
  assert.equal(config.maxAge, 7200);
  assert.equal(config.timeout, 5000);
  const boundary = readConfig({ GITHUB_TOKEN: 'test-token', CACHE_TTL_SECONDS: '86400', CACHE_MAX_AGE_SECONDS: '1' });
  assert.equal(boundary.maxAge, boundary.ttl);
});

test('optional fallback values use the same cache fingerprint as effective defaults', () => {
  const defaults = readConfig({ GITHUB_TOKEN: 'test-token' });
  const fallback = readConfig({ GITHUB_TOKEN: 'test-token', CACHE_TTL_SECONDS: '', CACHE_MAX_AGE_SECONDS: 'bad', GITHUB_TIMEOUT_MS: '0', CACHE_NAMESPACE: 'invalid/value', CACHE_VERSION: ' ' });
  assert.equal(fallback.prefix, defaults.prefix);
});

test('empty CORS uses default and wildcard accepts surrounding whitespace', () => {
  for (const value of ['', '   ', ' * ']) {
    assert.equal(readConfig({ GITHUB_TOKEN: 'test-token', CORS_ORIGINS: value }).origins, '*');
  }
});

test('CORS normalizes trailing slashes, casing and default ports without broadening access', () => {
  const config = readConfig({ GITHUB_TOKEN: 'test-token', CORS_ORIGINS: ' https://SITE.test:443/, https://site.test, http://localhost:5173/ ' });
  assert.deepEqual(config.origins, new Set(['https://site.test', 'http://localhost:5173']));
  assert.equal(config.prefix, readConfig({ GITHUB_TOKEN: 'test-token', CORS_ORIGINS: 'https://site.test,http://localhost:5173' }).prefix);
  for (const value of ['https://site.test/path', 'https://user:secret@site.test', 'https://site.test?q=1', 'https://site.test/#fragment', 'site.test', '*,https://site.test', ',']) {
    assert.throws(() => readConfig({ GITHUB_TOKEN: 'test-token', CORS_ORIGINS: value }), ConfigurationError);
  }
});

test('HEAD configuration errors have no response body', async () => {
  const previous = process.env.GITHUB_TOKEN;
  const originalLog = console.error;
  try {
    delete process.env.GITHUB_TOKEN;
    console.error = () => {};
    const response = await api.fetch(new Request('https://proxy.test/', { method: 'HEAD' }));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), '');
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
    console.error = originalLog;
  }
});
