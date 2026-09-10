import { type Cache, MemoryCache } from './cache.js';
import { type Config, hash, HttpError } from './config.js';
import { errorResponse } from './errors.js';
import { paginationRoute, parseRoute, redirectRoute, type Route, routeUrl } from './routes.js';

type AuthMode = 'token' | 'anonymous';
interface Entry { auth?: AuthMode; body: string; checkedAt: number; etag?: string; link?: string; status?: 200 | 204 }
interface Result { entry: Entry; state: 'HIT' | 'MISS' | 'REVALIDATED' | 'STALE'; retryAfter?: number }
interface Dependencies {
  cache: Cache;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

export function createProxy(config: Config, dependencies: Dependencies) {
  const now = dependencies.now ?? Date.now;
  const fetcher = dependencies.fetch ?? fetch;
  const log = dependencies.log ?? (event => console.info(JSON.stringify(event)));
  const local = new MemoryCache(now);
  const inFlight = new Map<string, Promise<Result>>();
  let queue: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const cooldowns = { token: 0, anonymous: 0 };
  const limits = { token: 0, anonymous: 0 };
  const cooldownKeys = { token: config.cooldownKey, anonymous: `${config.cooldownKey.split(':cooldown:')[0]}:cooldown:anonymous` };
  const fallbackKey = (repository: string) => `${config.prefix}:anonymous:${repository}`;
  const ttlFor = (route: Route) => route.kind === 'rate-limit' ? Math.min(5, config.ttl) : config.ttl;
  const keyOf = (route: Route) => `${config.prefix}:${hash(routeUrl(route))}`;

  async function read<T>(key: string): Promise<T | undefined> {
    try { return (await dependencies.cache.get<T>(key)) ?? await local.get<T>(key); }
    catch { log({ event: 'cache_degraded', operation: 'get' }); return local.get<T>(key); }
  }
  async function write(key: string, value: unknown, ttl: number) {
    await local.set(key, value, ttl);
    try { await dependencies.cache.set(key, value, ttl); }
    catch { log({ event: 'cache_degraded', operation: 'set' }); }
  }
  async function remove(key: string) {
    await local.delete(key);
    try { await dependencies.cache.delete(key); }
    catch { log({ event: 'cache_degraded', operation: 'delete' }); }
  }
  const age = (entry: Entry) => Math.max(0, (now() - entry.checkedAt) / 1000);

  async function checkCooldown(auth: AuthMode) {
    cooldowns[auth] = Math.max(cooldowns[auth], (await read<number>(cooldownKeys[auth])) ?? 0);
    if (cooldowns[auth] > now()) throw new HttpError(429, 'GitHub requests are cooling down', Math.ceil((cooldowns[auth] - now()) / 1000));
  }

  async function serial<T>(work: () => Promise<T>): Promise<T> {
    if (queued >= 32) throw new HttpError(503, 'Upstream queue is full', 1);
    queued++;
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new HttpError(503, 'Upstream queue timed out', 1)); }, 5000);
    });
    const job = queue.then(async () => {
      if (expired) throw new HttpError(503, 'Upstream queue timed out', 1);
      clearTimeout(timer);
      return work();
    });
    queue = job.catch(() => {}).finally(() => { queued--; });
    try { return await Promise.race([job, timeout]); }
    finally { clearTimeout(timer!); }
  }

  async function bodyText(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 768 * 1024) throw new HttpError(502, 'GitHub response too large; use a smaller per_page');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function publicRepository(repository: string, signal: AbortSignal) {
    const route = parseRoute(`/repos/${repository}`, config);
    const key = keyOf(route);
    const entry = await read<Entry>(key);
    if (entry && age(entry) < config.ttl) return;
    try {
      const checked = await upstream(route, entry, signal);
      await write(key, checked, config.maxAge);
    } catch (error) {
      if (error instanceof HttpError && [401, 403, 404].includes(error.status)) await remove(key);
      throw error;
    }
  }

  async function upstream(initial: Route, old: Entry | undefined, signal: AbortSignal): Promise<Entry> {
    let route = initial;
    let forceAnonymous = false;
    let fallbackAttempted = false;
    async function accept(entry: Entry, auth: AuthMode): Promise<Entry> {
      limits[auth] = 0;
      if (auth === 'anonymous' && fallbackAttempted && route.repository) {
        await write(fallbackKey(route.repository), now() + 300_000, 300);
      }
      return { ...entry, auth };
    }
    for (let redirects = 0; redirects <= 3;) {
      if (route.repository && route.kind !== 'repo') {
        await publicRepository(route.repository, signal);
      }
      const preferAnonymous = route.repository && (await read<number>(fallbackKey(route.repository)) ?? 0) > now();
      const auth: AuthMode = forceAnonymous || preferAnonymous ? 'anonymous' : 'token';
      await checkCooldown(auth);
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'gh-api',
      };
      if (auth === 'token') headers.Authorization = `Bearer ${config.token}`;
      const canRevalidate = old && redirects === 0 && (old.auth ?? 'token') === auth;
      // An ETag belongs to a specific resource, never a different redirect target.
      if (canRevalidate && old.etag) headers['If-None-Match'] = old.etag;
      log({ event: 'github_request', path: route.path, auth });
      const response = await fetcher(routeUrl(route), { headers, redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new HttpError(502, 'Unsupported upstream redirect');
        route = redirectRoute(location, route, config);
        redirects++;
        continue;
      }
      const text = await bodyText(response);
      let data: any;
      try { data = text ? JSON.parse(text) : null; }
      catch { /* Status and rate-limit headers are authoritative, even for HTML errors. */ }
      const limited = response.status === 429 || (response.status === 403 && (
        response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') ||
        /rate limit|abuse detection/i.test(data?.message ?? '')
      ));
      if (limited) {
        limits[auth]++;
        const retry = response.headers.get('retry-after');
        const retryAt = retry ? (/^\d+$/.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry)) : 0;
        const resetAt = response.headers.get('x-ratelimit-remaining') === '0' ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : 0;
        const requiredAt = Math.max(Number.isFinite(retryAt) ? retryAt : 0, Number.isFinite(resetAt) ? resetAt : 0);
        cooldowns[auth] = Math.max(cooldowns[auth], requiredAt > now() ? requiredAt : now() + Math.min(3600, 60 * 2 ** Math.min(limits[auth] - 1, 6)) * 1000);
        const seconds = Math.max(1, Math.ceil((cooldowns[auth] - now()) / 1000));
        await write(cooldownKeys[auth], cooldowns[auth], seconds);
        log({ event: 'github_rate_limited', retryAfter: seconds, auth });
        throw new HttpError(429, 'GitHub rate limit reached', seconds);
      }
      // Only the observed PAT lifetime policy is eligible. Never downgrade generic
      // authorization, SSO/IP restrictions, invalid tokens, or rate limits.
      if (auth === 'token' && !fallbackAttempted && route.repository && response.status === 403 &&
          typeof data?.message === 'string' &&
          /^The '[^']+' organization forbids access via (?:a )?fine-grained personal access tokens? if the token's lifetime is greater than \d+ days\./i.test(data.message)) {
        fallbackAttempted = true;
        forceAnonymous = true;
        log({ event: 'github_anonymous_fallback', path: route.path, reason: 'token_lifetime_policy' });
        continue;
      }
      if (fallbackAttempted) log({ event: 'github_anonymous_result', path: route.path, status: response.status });
      if (response.status >= 500) throw new HttpError(502, 'GitHub is temporarily unavailable');
      if ([200, 204, 304].includes(response.status) && response.headers.get('x-ratelimit-remaining') === '0') {
        const resetAt = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        if (Number.isFinite(resetAt) && resetAt > now()) {
          cooldowns[auth] = Math.max(cooldowns[auth], resetAt);
          await write(cooldownKeys[auth], cooldowns[auth], Math.ceil((cooldowns[auth] - now()) / 1000));
        }
      }
      if (response.status === 304 && canRevalidate) {
        return accept({ ...old, checkedAt: now(), etag: response.headers.get('etag') ?? old.etag }, auth);
      }
      if (response.status === 204 && route.kind === 'contributors') return accept({ body: '', checkedAt: now(), status: 204 }, auth);
      if (response.status !== 200) {
        // Do not relay upstream error bodies, which can contain privileged details.
        throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502, `GitHub request failed (${response.status})`, undefined, 'UPSTREAM_REQUEST_FAILED');
      }
      if (data === undefined || data === null) throw new HttpError(502, 'Invalid GitHub JSON response');
      if (route.kind === 'repo' && data?.private !== false) throw new HttpError(403, 'Only public repositories are supported');
      if (['user-repos', 'org-repos', 'user-starred', 'user-subscriptions', 'forks'].includes(route.kind) && (!Array.isArray(data) || data.some(repo => repo.private !== false))) throw new HttpError(403, 'Only public repositories are supported');
      return accept({ body: text, checkedAt: now(), etag: response.headers.get('etag') ?? undefined, link: response.headers.get('link') ?? undefined }, auth);
    }
    throw new HttpError(502, 'Too many redirects');
  }

  async function load(route: Route): Promise<Result> {
    const key = keyOf(route);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const job = (async (): Promise<Result> => {
      const cached = await read<Entry>(key);
      if (cached && age(cached) < ttlFor(route)) return { entry: cached, state: 'HIT' };
      try {
        return await serial(async () => {
          // Another instance may have filled the regional cache while this request queued.
          const latest = await read<Entry>(key);
          if (latest && age(latest) < ttlFor(route)) return { entry: latest, state: 'HIT' };
          const entry = await upstream(route, latest ?? cached, AbortSignal.timeout(config.timeout));
          await write(key, entry, config.maxAge);
          return { entry, state: latest || cached ? 'REVALIDATED' : 'MISS' };
        });
      } catch (error) {
        const failure = error instanceof HttpError ? error : new HttpError(502, 'GitHub request timed out or failed');
        if ([401, 403, 404].includes(failure.status)) await remove(key);
        if (route.kind !== 'rate-limit' && [429, 502, 503].includes(failure.status) && cached && age(cached) < config.maxAge) {
          return { entry: cached, state: 'STALE', retryAfter: failure.retryAfter };
        }
        throw failure;
      }
    })();
    inFlight.set(key, job);
    try { return await job; } finally { inFlight.delete(key); }
  }

  return async function handle(request: Request): Promise<Response> {
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const origin = request.headers.get('origin');
    if (config.origins !== '*') headers.set('Vary', 'Origin');
    try {
      if (config.origins !== '*' && origin && !config.origins.has(origin)) throw new HttpError(403, 'Origin is not allowed');
      if (config.origins === '*') headers.set('Access-Control-Allow-Origin', '*');
      else if (origin) headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Expose-Headers', 'Link, X-Proxy-Cache, X-Proxy-Checked-At, Retry-After');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        headers.set('Allow', 'GET, HEAD, OPTIONS'); throw new HttpError(405, 'Only GET, HEAD and OPTIONS are supported');
      }
      const url = new URL(request.url);
      const route = parseRoute(url.pathname + url.search, config);
      if (request.method === 'OPTIONS') {
        if (request.headers.has('access-control-request-method') && !['GET', 'HEAD'].includes(request.headers.get('access-control-request-method')!)) throw new HttpError(405, 'Only GET and HEAD are supported');
        const requested = request.headers.get('access-control-request-headers');
        if (requested && requested.split(',').some(h => !['accept', 'content-type', 'x-requested-with'].includes(h.trim().toLowerCase()))) throw new HttpError(400, 'Unsupported request headers');
        headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Accept, Content-Type, X-Requested-With');
        return new Response(null, { status: 204, headers });
      }
      const result = await load(route);
      headers.set('X-Proxy-Cache', result.state);
      headers.set('X-Proxy-Checked-At', new Date(result.entry.checkedAt).toISOString());
      if (result.retryAfter) headers.set('Retry-After', String(result.retryAfter));
      if (result.entry.link) {
        // Relative proxy links avoid trusting Host / forwarded headers and bypassing the proxy.
        const links: string[] = [];
        for (const match of result.entry.link.matchAll(/<([^>]+)>;\s*rel="(next|prev|first|last)"/g)) {
          try {
            const target = paginationRoute(match[1], route, config);
            links.push(`<${target.path}${target.query ? `?${target.query}` : ''}>; rel="${match[2]}"`);
          } catch { /* Never forward unsupported pagination destinations. */ }
        }
        if (links.length) headers.set('Link', links.join(', '));
      }
      if (result.state !== 'STALE') {
        const remaining = Math.floor(ttlFor(route) - age(result.entry));
        if (remaining > 0) {
          headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
          headers.set('Vercel-CDN-Cache-Control', `public, s-maxage=${remaining}, must-revalidate`);
        }
      }
      log({ event: 'response', cache: result.state, path: route.path });
      return new Response(request.method === 'HEAD' || result.entry.status === 204 ? null : result.entry.body, { status: result.entry.status ?? 200, headers });
    } catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(500, 'Internal proxy error');
      log({ event: 'response_error', status: failure.status });
      const response = errorResponse(failure, headers);
      return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
  };
}
