import assert from 'node:assert/strict';
import { test } from 'node:test';
import api from '../api/index.js';
import { ConfigurationError, readConfig } from '../src/config.js';

test('configuration errors identify invalid fields without exposing their values', () => {
  const cases = [
    ['GITHUB_TOKEN', 'secret token'],
    ['GITHUB_ALLOWLIST', 'secret/repo/extra'],
    ['CACHE_TTL_SECONDS', 'secret'],
    ['CACHE_MAX_AGE_SECONDS', '1'],
    ['GITHUB_TIMEOUT_MS', 'secret'],
    ['CORS_ORIGINS', 'https://secret.test/path'],
    ['CACHE_NAMESPACE', 'secret/value'],
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
    assert.equal(body.field, 'GITHUB_TOKEN');
    assert.match(body.reason, /redeploy/);
    assert.equal(JSON.parse(logs[0]).field, 'GITHUB_TOKEN');
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
    console.error = originalLog;
  }
});
