import { type Config, HttpError, ownerPattern, repoPattern } from './config.js';

export interface Route { path: string; query: string; repository?: string; kind: string }
const pagination = ['page', 'per_page'];

export function parseRoute(raw: string, config: Config): Route {
  if (raw.length > 4096 || /[\\#\x00-\x20]/.test(raw)) throw new HttpError(400, 'Invalid path');
  const [path, query = '', ...extra] = raw.split('?');
  if (extra.length || /%|\/\//.test(path)) throw new HttpError(400, 'Encoded or empty path segments are not supported');
  const parts = path.split('/').slice(1);
  if (!path.startsWith('/') || parts.some(p => !p || p === '.' || p === '..')) throw new HttpError(400, 'Invalid path');
  const [root, owner, repo, ...tail] = parts;
  if (!owner || !ownerPattern.test(owner)) throw new HttpError(404, 'Unsupported endpoint');
  let allowed: string[] = [];
  let kind = '';
  let repository: string | undefined;
  if (root === 'users') {
    if (!config.owners.has(owner.toLowerCase())) throw new HttpError(403, 'Owner is not allowed');
    if (parts.length === 2) kind = 'user';
    else if (parts.length === 3 && repo === 'repos') {
      kind = 'user-repos'; allowed = [...pagination, 'type', 'sort', 'direction'];
    }
  } else if (root === 'repos' && repo && repoPattern.test(repo)) {
    repository = `${owner}/${repo}`.toLowerCase();
    if (!config.owners.has(owner.toLowerCase()) && !config.repos.has(repository)) throw new HttpError(403, 'Repository is not allowed');
    const suffix = tail.join('/');
    if (!suffix) kind = 'repo';
    else if (suffix === 'issues') {
      kind = 'issues'; allowed = [...pagination, 'state', 'labels', 'sort', 'direction', 'since', 'creator', 'mentioned', 'assignee', 'milestone'];
    } else if (/^issues\/[1-9]\d*$/.test(suffix)) kind = 'issue';
    else if (/^issues\/[1-9]\d*\/comments$/.test(suffix) || suffix === 'issues/comments') {
      kind = 'comments'; allowed = [...pagination, 'since'];
      if (suffix === 'issues/comments') allowed.push('sort', 'direction');
    } else if (/^issues\/comments\/[1-9]\d*$/.test(suffix)) kind = 'comment';
    else if (suffix === 'releases') { kind = 'releases'; allowed = pagination; }
    else if (/^releases\/(latest|[1-9]\d*)$/.test(suffix)) kind = 'release';
    else if (suffix === 'contributors') { kind = 'contributors'; allowed = [...pagination, 'anon']; }
  }
  if (!kind) throw new HttpError(404, 'Unsupported endpoint');
  const input = new URLSearchParams(query);
  const output = new URLSearchParams();
  for (const [key, value] of input) {
    if (!allowed.includes(key) || input.getAll(key).length !== 1 || !value || value.length > 500 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new HttpError(400, 'Unsupported or duplicate query parameter');
    }
    const enums: Record<string, string[]> = {
      state: ['open', 'closed', 'all'], direction: ['asc', 'desc'], anon: ['true', 'false', '1', '0'],
      type: ['all', 'owner', 'member'],
      sort: kind === 'user-repos' ? ['created', 'updated', 'pushed', 'full_name'] : kind === 'issues' ? ['created', 'updated', 'comments'] : ['created', 'updated'],
    };
    if (enums[key] && !enums[key].includes(value)) throw new HttpError(400, `Invalid ${key}`);
    if (pagination.includes(key)) {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > (key === 'per_page' ? 100 : 10000)) throw new HttpError(400, `Invalid ${key}`);
    }
    if (key === 'since' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || !Number.isFinite(Date.parse(value)))) throw new HttpError(400, 'Invalid since');
    output.set(key, value);
  }
  output.sort();
  // Only owner/repository names are case insensitive; route keywords remain strict.
  parts[1] = owner.toLowerCase();
  if (root === 'repos') parts[2] = repo.toLowerCase();
  return { path: `/${parts.join('/')}`, query: output.toString(), repository, kind };
}

export const routeUrl = (route: Route) => `https://api.github.com${route.path}${route.query ? `?${route.query}` : ''}`;

export function redirectRoute(location: string, current: Route, config: Config): Route {
  // Reject dot/encoded paths before URL normalization can hide them.
  if (/[\\#%]/.test(location) || /(?:^|\/)\.{1,2}(?:\/|$|\?)/.test(location)) throw new HttpError(502, 'Unsafe upstream redirect');
  const target = new URL(location, routeUrl(current));
  if (target.origin !== 'https://api.github.com' || target.username || target.password) throw new HttpError(502, 'Unsafe upstream redirect');
  const route = parseRoute(target.pathname + target.search, config);
  if (route.kind !== current.kind) throw new HttpError(502, 'Unsupported upstream redirect');
  return route;
}
