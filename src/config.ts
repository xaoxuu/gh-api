import { createHash } from 'node:crypto';

export class HttpError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
  }
}

/** Only static validation messages belong here; never include environment values. */
export class ConfigurationError extends Error {
  constructor(public field: string, message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export const ownerPattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
export const repoPattern = /^(?!\.{1,2}$)[a-z0-9_.-]{1,100}$/i;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export interface Config {
  token: string;
  owners: Set<string>;
  repos: Set<string>;
  ttl: number;
  maxAge: number;
  timeout: number;
  origins: Set<string> | '*';
  prefix: string;
  cooldownKey: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) throw new ConfigurationError('GITHUB_TOKEN', 'Set GITHUB_TOKEN in the deployment environment, then redeploy');
  if (/\s/.test(token)) throw new ConfigurationError('GITHUB_TOKEN', 'GITHUB_TOKEN must not contain whitespace');
  const owners = new Set<string>();
  const repos = new Set<string>();
  const raw = env.GITHUB_ALLOWLIST?.trim() ?? '';
  for (const rule of raw ? raw.split(',') : []) {
    const entry = rule.trim().toLowerCase();
    const parts = entry.split('/');
    if (!ownerPattern.test(parts[0]) || parts.length > 2 || (parts.length === 2 && !repoPattern.test(parts[1]))) {
      throw new ConfigurationError('GITHUB_ALLOWLIST', 'Use comma-separated owner or owner/repo entries, without empty entries');
    }
    (parts.length === 1 ? owners : repos).add(entry);
  }
  function integer(key: string, fallback: number, min: number, max: number) {
    const value = env[key] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new ConfigurationError(key, `${key} must be an integer between ${min} and ${max}`);
    return Number(value);
  }
  const ttl = integer('CACHE_TTL_SECONDS', 1800, 1, 86400);
  const maxAge = integer('CACHE_MAX_AGE_SECONDS', 86400, ttl, 604800);
  const timeout = integer('GITHUB_TIMEOUT_MS', 10000, 100, 15000);
  const originValue = env.CORS_ORIGINS ?? '*';
  const origins = originValue === '*' ? '*' : new Set(originValue.split(',').map(value => {
    const origin = value.trim();
    try {
      const url = new URL(origin);
      if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) throw new Error();
    } catch { throw new ConfigurationError('CORS_ORIGINS', 'Use * or comma-separated HTTP(S) origins without paths or trailing slashes'); }
    return origin;
  }));
  const namespace = env.CACHE_NAMESPACE ?? env.VERCEL_PROJECT_ID ?? 'gh-api';
  if (!/^[\w-]{1,100}$/.test(namespace)) throw new ConfigurationError('CACHE_NAMESPACE', 'Use 1 to 100 letters, digits, underscores or hyphens');
  const fingerprint = hash(JSON.stringify({
    schema: 1, owners: [...owners].sort(), repos: [...repos].sort(), ttl, maxAge, timeout,
    origins: origins === '*' ? '*' : [...origins].sort(), version: env.CACHE_VERSION ?? '1',
    token: hash(token),
  }));
  const scope = `${namespace}:${env.VERCEL_ENV ?? 'development'}`;
  return { token, owners, repos, ttl, maxAge, timeout, origins,
    prefix: `${scope}:${fingerprint}`, cooldownKey: `${scope}:cooldown:${hash(token)}` };
}
