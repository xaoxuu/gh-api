import assert from 'node:assert/strict';
const base = process.argv[2] ?? 'https://gh-api-bice.vercel.app';
for (const path of ['/', '/rate_limit']) {
  const response = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, path);
  const data = await response.json();
  if (path === '/') assert.equal(data.user_url, 'https://api.github.com/users/{user}');
  else assert.equal(typeof data.resources.core.remaining, 'number');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  console.log(JSON.stringify({ path, status: response.status, cache: response.headers.get('x-vercel-cache') }));
}
