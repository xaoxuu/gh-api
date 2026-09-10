import { type Config, HttpError, ownerPattern, repoPattern } from './config.js';

export interface Route { path: string; query: string; repository?: string; kind: string }
const pagination = ['page', 'per_page'];
const repositoryLists: Record<string, string[]> = {
  stargazers: pagination, subscribers: pagination,
  forks: [...pagination, 'sort'], branches: [...pagination, 'protected'],
  commits: [...pagination, 'sha', 'path', 'author', 'committer', 'since', 'until'],
  languages: [], topics: [], labels: pagination,
  milestones: [...pagination, 'state', 'sort', 'direction'],
  pulls: [...pagination, 'state', 'head', 'base', 'sort', 'direction'],
};
const userLists: Record<string, string[]> = {
  followers: pagination, following: pagination, orgs: pagination,
  starred: [...pagination, 'sort', 'direction'], subscriptions: pagination,
};

export function parseRoute(raw: string, config: Config): Route {
  if (raw.length > 4096 || /[\\#\x00-\x20]/.test(raw)) throw new HttpError(400, 'Invalid path');
  const [path, query = '', ...extra] = raw.split('?');
  if (extra.length || /%|\/\//.test(path)) throw new HttpError(400, 'Encoded or empty path segments are not supported');
  if (path === '/' || path === '/rate_limit') {
    const input = new URLSearchParams(query);
    if (input.size) throw new HttpError(400, 'Unsupported query parameter');
    return { path, query: '', kind: path === '/' ? 'discovery' : 'rate-limit' };
  }
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
    } else if (parts.length === 3 && Object.hasOwn(userLists, repo)) {
      kind = `user-${repo}`; allowed = userLists[repo];
    }
  } else if (root === 'orgs') {
    if (!config.owners.has(owner.toLowerCase())) throw new HttpError(403, 'Owner is not allowed');
    if (parts.length === 2) kind = 'org';
    else if (parts.length === 3 && repo === 'repos') {
      kind = 'org-repos'; allowed = [...pagination, 'type', 'sort', 'direction'];
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
    else if (suffix === 'tags') { kind = 'tags'; allowed = pagination; }
    else if (/^releases\/(latest|[1-9]\d*)$/.test(suffix)) kind = 'release';
    else if (suffix === 'contributors') { kind = 'contributors'; allowed = [...pagination, 'anon']; }
    else if (Object.hasOwn(repositoryLists, suffix)) { kind = suffix; allowed = repositoryLists[suffix]; }
    else if (/^pulls\/[1-9]\d*$/.test(suffix)) kind = 'pull';
    else if (/^milestones\/[1-9]\d*$/.test(suffix)) kind = 'milestone';
    else if (/^issues\/[1-9]\d*\/labels$/.test(suffix)) { kind = 'issue-labels'; allowed = pagination; }
  }
  if (!kind) throw new HttpError(404, 'Unsupported endpoint');
  const input = new URLSearchParams(query);
  const output = new URLSearchParams();
  for (const [key, value] of input) {
    if (!allowed.includes(key)) throw new HttpError(400, `Unsupported query parameter: ${key.slice(0, 80)}`);
    if (input.getAll(key).length !== 1) throw new HttpError(400, `Duplicate query parameter: ${key}`);
    if (!value || value.length > 500 || /[\x00-\x1f\x7f]/.test(value)) throw new HttpError(400, `Invalid query parameter: ${key}`);
    const enums: Record<string, string[]> = {
      state: ['open', 'closed', 'all'], direction: ['asc', 'desc'], anon: ['true', 'false', '1', '0'], protected: ['true', 'false'],
      type: kind === 'org-repos' ? ['public', 'forks', 'sources'] : ['all', 'owner', 'member'],
      sort: ['user-repos', 'org-repos'].includes(kind) ? ['created', 'updated', 'pushed', 'full_name']
        : kind === 'issues' ? ['created', 'updated', 'comments']
        : kind === 'forks' ? ['newest', 'oldest', 'stargazers']
        : kind === 'milestones' ? ['due_on', 'completeness']
        : kind === 'pulls' ? ['created', 'updated', 'popularity', 'long-running']
        : ['created', 'updated'],
    };
    if (enums[key] && !enums[key].includes(value)) throw new HttpError(400, `Invalid ${key}`);
    if (pagination.includes(key)) {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > (key === 'per_page' ? 100 : 10000)) throw new HttpError(400, `Invalid ${key}`);
    }
    if (['since', 'until'].includes(key) && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || !Number.isFinite(Date.parse(value)))) throw new HttpError(400, `Invalid ${key}`);
    output.set(key, value);
  }
  if (kind === 'org-repos' && !output.has('type')) output.set('type', 'public');
  output.sort();
  // Only owner/repository names are case insensitive; route keywords remain strict.
  parts[1] = owner.toLowerCase();
  if (root === 'repos') parts[2] = repo.toLowerCase();
  return { path: `/${parts.join('/')}`, query: output.toString(), repository, kind };
}

export const routeUrl = (route: Route) => `https://api.github.com${route.path}${route.query ? `?${route.query}` : ''}`;

export function redirectRoute(location: string, current: Route, config: Config): Route {
  // Reject dot/encoded paths before URL normalization can hide them.
  if (/[\\#]/.test(location) || location.split('?')[0].includes('%') || /(?:^|\/)\.{1,2}(?:\/|$|\?)/.test(location)) throw new HttpError(502, 'Unsafe upstream redirect');
  const target = new URL(location, routeUrl(current));
  if (target.origin !== 'https://api.github.com' || target.username || target.password) throw new HttpError(502, 'Unsafe upstream redirect');
  const route = parseRoute(target.pathname + target.search, config);
  if (route.kind !== current.kind) throw new HttpError(502, 'Unsupported upstream redirect');
  return route;
}

/** GitHub pagination can use numeric canonical IDs; keep the authorized named route. */
export function paginationRoute(location: string, current: Route, config: Config): Route {
  const target = new URL(location, routeUrl(current));
  if (target.origin !== 'https://api.github.com' || target.username || target.password || target.hash || /[\\#]/.test(location) || location.split('?')[0].includes('%')) {
    throw new HttpError(502, 'Unsafe pagination link');
  }
  const numericUser = current.path.startsWith('/users/') && /^\/user\/[1-9]\d*(?:\/|$)/.test(target.pathname)
    && target.pathname.replace(/^\/user\/[1-9]\d*/, '') === current.path.replace(/^\/users\/[^/]+/, '');
  const numericOrg = current.kind === 'org-repos' && /^\/organizations\/[1-9]\d*\/repos$/.test(target.pathname);
  const repositorySuffix = current.repository ? current.path.slice(`/repos/${current.repository}`.length) : undefined;
  const numericRepository = current.repository && /^\/repositories\/[1-9]\d*(?:\/|$)/.test(target.pathname)
    && target.pathname.replace(/^\/repositories\/[1-9]\d*/, '') === repositorySuffix;
  if (numericUser || numericOrg || numericRepository) return parseRoute(current.path + target.search, config);
  return redirectRoute(location, current, config);
}
