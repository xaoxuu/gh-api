# gh-api

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

[![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat&logo=vercel&logoColor=white)](#vercel-deployment)

A read-only GitHub API proxy built with Node.js and TypeScript, ready to deploy to Vercel. Frontends can access allowlisted public resources without holding a GitHub token.

- **Control resource access**: allowlist users, organizations, or individual repositories.
- **Reduce GitHub requests**: reuse data through Vercel CDN, regional Runtime Cache, ETag conditional requests, and request coalescing within each instance.
- **Connect your frontend**: preserve GitHub JSON structures with CORS, pagination links, and consistent error responses.
- **Deploy easily**: no database, Redis, or scheduled jobs required.

[Quick start](#quick-start) · [Supported endpoints](#supported-endpoints) · [Error responses](#error-responses) · [Environment variables](#environment-variables) · [Deployment maintenance and troubleshooting](#deployment-maintenance-and-troubleshooting) · [Caching and failure handling](#caching-and-failure-handling) · [Local development](#local-development)

## Quick start

### Vercel deployment

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fxaoxuu%2Fgh-api&env=GITHUB_TOKEN%2CGITHUB_ALLOWLIST&envLink=https%3A%2F%2Fgithub.com%2Fxaoxuu%2Fgh-api%23environment-variables&project-name=gh-api&repository-name=gh-api)

Click **Deploy with Vercel** to clone the repository and create a Vercel project. You will be prompted for `GITHUB_TOKEN` and `GITHUB_ALLOWLIST`; see [Environment variables](#environment-variables). To import manually:

1. Import the repository into Vercel. Select **Other** as the Framework Preset and **24.x** for Node.js. The project already configures the build command, `public` output directory, API routing, and a single-region function.
2. Set [environment variables](#environment-variables) for Production. Only `GITHUB_TOKEN` and `GITHUB_ALLOWLIST` need to be set; the cache namespace defaults to the project ID. Configure Preview variables separately if needed for testing.
3. Use the generated domain after deployment. No database, Redis, scheduled jobs, or administration page is needed.

### Configure the allowlist

```dotenv
GITHUB_ALLOWLIST=xaoxuu,vercel/next.js
```

| Rule | Authorized resources |
| --- | --- |
| `owner` | The owner's public profile, public repository list, and supported endpoints for all public repositories, including repositories created later |
| `owner/repo` | Supported endpoints for that repository only; does not authorize the owner's profile, repository list, or other repositories |

Rules are case-insensitive. Leading and trailing whitespace and duplicates are removed, and all rules apply together. Names must match in full; prefix matching is not used.

An empty allowlist denies all requests requiring owner or repository authorization. `/` and `/rate_limit` are exempt. Invalid formats such as empty entries, wildcards, or extra path segments fail configuration validation.

### Call from your frontend

```js
const response = await fetch(
  'https://YOUR-PROJECT.vercel.app/repos/vercel/next.js/issues?state=open&per_page=20&page=1'
);
if (!response.ok) throw new Error(`GitHub proxy: ${response.status}`);
const issues = await response.json();
console.log(issues, response.headers.get('X-Proxy-Cache'));
```

Successful responses preserve GitHub JSON structures. Pages are not automatically aggregated. GitHub URLs in the `Link` response header are rewritten as `/...` relative URLs; resolve them against the proxy domain, for example with `new URL(nextPath, 'https://YOUR-PROJECT.vercel.app')`. Fields such as `url` inside JSON remain unchanged. Use the proxy endpoints below for subsequent requests.

## Supported endpoints

Only the following endpoints are exposed, with support for `GET`, `HEAD`, and `OPTIONS`.

### API root and rate limits

| Path | Description |
| --- | --- |
| `/` | Returns the GitHub API root JSON, preserving its original GitHub links |
| `/rate_limit` | Returns rate limit information for the server token; cached for at most 5 seconds, never served stale, and respects retry times during cooldown |

These two endpoints do not require an allowlist match. They only accept—and remove—the `_` and `timestamp` parameters. Links in the root JSON do not imply support for every GitHub endpoint.

### Users, organizations, and repositories

| GitHub path | Supported query parameters |
| --- | --- |
| `/users/:owner` | None |
| `/users/:owner/repos` | `page`, `per_page`, `type`, `sort`, `direction` |
| `/users/:owner/followers`, `/users/:owner/following`, `/users/:owner/orgs`, `/users/:owner/subscriptions` | `page`, `per_page` |
| `/users/:owner/starred` | `page`, `per_page`, `sort`, `direction` |
| `/orgs/:owner` | None |
| `/orgs/:owner/repos` | `page`, `per_page`, `type`, `sort`, `direction` |
| `/repos/:owner/:repo` | None |
| `/repos/:owner/:repo/issues` | `page`, `per_page`, `state`, `labels`, `sort`, `direction`, `since`, `creator`, `mentioned`, `assignee`, `milestone`, `type`, `issue_field_values` |
| `/repos/:owner/:repo/issues/:number` | None |
| `/repos/:owner/:repo/issues/:number/comments` | `page`, `per_page`, `since` |
| `/repos/:owner/:repo/issues/comments` | `page`, `per_page`, `since`, `sort`, `direction` |
| `/repos/:owner/:repo/issues/comments/:id` | None |
| `/repos/:owner/:repo/releases` | `page`, `per_page` |
| `/repos/:owner/:repo/tags` | `page`, `per_page` |
| `/repos/:owner/:repo/releases/latest`, `/repos/:owner/:repo/releases/:id` | None |
| `/repos/:owner/:repo/contributors` | `page`, `per_page`, `anon`; accepts `direction=asc/desc` for compatibility (ignored) |
| `/repos/:owner/:repo/stargazers`, `/repos/:owner/:repo/subscribers` | `page`, `per_page` |
| `/repos/:owner/:repo/forks` | `page`, `per_page`, `sort` |
| `/repos/:owner/:repo/branches` | `page`, `per_page`, `protected` |
| `/repos/:owner/:repo/commits` | `page`, `per_page`, `sha`, `path`, `author`, `committer`, `since`, `until` |
| `/repos/:owner/:repo/languages` | None |
| `/repos/:owner/:repo/topics` | `page`, `per_page` |
| `/repos/:owner/:repo/labels`, `/repos/:owner/:repo/issues/:number/labels` | `page`, `per_page` |
| `/repos/:owner/:repo/milestones` | `page`, `per_page`, `state`, `sort`, `direction` |
| `/repos/:owner/:repo/milestones/:number` | None |
| `/repos/:owner/:repo/pulls` | `page`, `per_page`, `state`, `head`, `base`, `sort`, `direction` |
| `/repos/:owner/:repo/pulls/:number` | None |

### Request and parameter rules

`HEAD` uses the same public visibility checks, authorization, and caching as `GET`, omitting only the response body. A cold cache still requires an upstream `GET`. CORS preflight allows `Accept`, `Content-Type`, and `X-Requested-With`; these client headers are not forwarded verbatim to GitHub.

- **Pagination**: `per_page` accepts 1–100 and `page` accepts 1–10000. Leading zeros are allowed and normalized to ordinary integers.
- **Timestamps**: `since` and `until` use UTC format `YYYY-MM-DDTHH:mm:ssZ`.
- **Enumerations**: allowed values follow each endpoint's validation rules; some exceptions are described below.
- **Cache parameters**: `_` and `timestamp` are removed from every endpoint and excluded from Runtime Cache keys.
- **Input restrictions**: unknown parameters, duplicate parameters, encoded path segments, and arbitrary upstream URLs are rejected.

Search, file contents, GraphQL, write endpoints, and the authenticated identity endpoint `/user` are unsupported. GitHub Issues lists may include pull requests, matching GitHub's original behavior.

### Endpoint-specific rules

An owner can be a user or organization name. Endpoints under `/users` and `/orgs` require an owner-level allowlist entry. Organization repository lists query public repositories only by default; `type` accepts `public`, `forks`, or `sources`. Stargazers use GitHub's default user-list format; watchers correspond to `/subscribers`. Branches and commits are available as list endpoints.

- **Contributors**: always returned in descending contribution order. The compatibility parameter `direction=asc/desc` is validated and removed; it does not affect ordering and shares Runtime Cache with requests that omit it.
- **Forks**: `sort` supports `newest`, `oldest`, `stargazers`, and `watchers`.
- **Issues**: `type` accepts a type name, `*`, or `none`. `issue_field_values` accepts field filters such as `priority:Urgent`, provided the repository has enabled those fields. These rules do not apply to `type` on organization repository lists.

Parameter normalization only consolidates Runtime Cache and upstream requests. Vercel CDN may still cache different original URLs separately. Normalization does not bypass public visibility checks, the allowlist, endpoint restrictions, input length limits, or rate limiting.

## Error responses

Application errors use the following JSON structure. The HTTP status matches `status`, and caching is disabled:

```json
{
  "success": false,
  "code": "RATE_LIMITED",
  "status": 429,
  "message": "GitHub rate limit reached",
  "details": null,
  "retryAfter": 60
}
```

Check `response.ok` first, then handle errors by `code`. Use `message` for display only, not to identify error types. Every error JSON includes all six fields above. `details` is `null` when no additional information is available. `retryAfter` is `null` when no retry time is available; otherwise it is a number of seconds matching the `Retry-After` header. Successful responses remain GitHub's original JSON; `204` and `HEAD` responses have no body.

| code | Meaning |
| --- | --- |
| `INVALID_REQUEST` | Invalid path, query parameters, or preflight request headers |
| `FORBIDDEN` | Access denied by the allowlist, Origin policy, or public repository restriction |
| `UNSUPPORTED_ENDPOINT` | Unsupported endpoint |
| `METHOD_NOT_ALLOWED` | Unsupported HTTP method |
| `UPSTREAM_REQUEST_FAILED` | GitHub request failed; ordinary `4xx` statuses are preserved (rate limits are handled separately), while other unexpected statuses map to 502 |
| `RATE_LIMITED` | GitHub rate limit reached or cooldown active |
| `UPSTREAM_ERROR` | GitHub service failure, network error/timeout, or invalid response format or size |
| `SERVICE_UNAVAILABLE` | Upstream queue full or queue wait timed out |
| `INVALID_CONFIGURATION` | Invalid service configuration; `details` contains safe `field` and `reason` values (or is `null` when the cause is unknown) |
| `INTERNAL_ERROR` | Internal proxy error |

## Environment variables

Set `GITHUB_TOKEN` and `GITHUB_ALLOWLIST` to get started. All other configuration is optional.

| Variable | Default | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | Required | GitHub fine-grained PAT with Repository access set to **Public repositories (read-only)**; do not grant private repository access |
| `GITHUB_ALLOWLIST` | Empty | Comma-separated owner or owner/repo entries |
| `CACHE_TTL_SECONDS` | `1800` | Freshness period, 1–86400 seconds |
| `CACHE_MAX_AGE_SECONDS` | `86400` | Maximum age of data served during upstream failures, measured from the last successful validation; must be at least the freshness period and at most 604800 seconds |
| `CACHE_NAMESPACE` | Vercel project ID; `gh-api` locally | Cache namespace; a distinct value per project is recommended |
| `CACHE_VERSION` | `1` | Manually change the Runtime Cache version; redeploy after changing it |
| `CORS_ORIGINS` | `*` | Unset or empty uses the default; otherwise a comma-separated list of HTTP(S) origins, such as `https://example.com,http://localhost:5173`. Trims whitespace and trailing slashes and normalizes hostname case and default ports; paths, query parameters, and credentials are rejected |
| `GITHUB_TIMEOUT_MS` | `10000` | Timeout for one upstream operation, including public visibility checks and redirects; 100–15000 milliseconds |
| `PORT` | `3000` | Local server only |

### Defaults and validation

Cache and timeout parameters are trimmed. Empty values, non-integers, and values outside the ranges above fall back to defaults. `CACHE_MAX_AGE_SECONDS` also falls back to 86400 seconds if it is less than the effective freshness period.

An invalid or empty `CACHE_NAMESPACE` uses the project ID (`gh-api` locally); an empty `CACHE_VERSION` uses `1`. The token, allowlist, and explicitly configured CORS rules are strictly validated to avoid accidentally broadening access through misconfiguration.

### Token and access boundaries

The token is never returned to the frontend or logged. Client Authorization, Cookie, and custom Accept headers are not sent to GitHub. Repository metadata must explicitly contain `private: false`. Before fetching repository subresources, the proxy checks and caches public visibility to prevent private repository access through an overly permissive token. Access decisions and visibility checks reflect the cached state; visibility changes on GitHub may not be detected until freshness expires. Always use a token limited to public resources.

CORS is a browser cross-origin policy, not authentication. Server requests without an Origin can still access allowlisted resources. Do not embed a supposedly secret API key in frontend code.

## Deployment maintenance and troubleshooting

### Revoking access and old deployments

Environment variables are deployment snapshots. **Editing Vercel environment variables alone does not change a running deployment.** After changing the allowlist, token, CORS, or TTL, redeploy and move the production domain to the new deployment.

New deployments have separate CDN cache keys, and new configuration fingerprints isolate the previous Runtime Cache, so the production domain no longer reuses responses authorized by the old configuration. Old deployment URLs still use the old allowlist. Restrict them with Deployment Protection or delete those deployments to revoke access across all URLs. Rolling back also restores the old configuration; redeploy the current configuration instead. See [Vercel CDN cache keys](https://vercel.com/docs/caching/cdn-cache/purge).

### Post-deployment verification

```sh
curl -i 'https://YOUR-PROJECT.vercel.app/repos/vercel/next.js'
# Repeat the URL and check x-vercel-cache: HIT; use curl -I to verify HEAD responses.
curl -i 'https://YOUR-PROJECT.vercel.app/repos/vercel/next.js'
curl -i -H 'Origin: https://example.com' 'https://YOUR-PROJECT.vercel.app/repos/vercel/next.js/issues?per_page=1'
```

- Verify a CDN hit on the second request and no new upstream fetch for the same resource in Runtime logs.
- Check that pagination `Link` URLs point to the proxy and that default or configured CORS behavior works.
- Requests for repositories outside the allowlist should return `403`; POST should return `405`.
- Revoke a rule and redeploy: the original URL should return `403`. Also check that old deployments are protected or deleted.

Automated tests cover application-level cache isolation and response headers. Real CDN hits, deployment rewrites, and access restrictions on old deployments require the checks above after deployment. Local tests do not automatically publish the project.

You can also run the live smoke test. It uses allowlisted user `xaoxuu` to check profiles, pagination, CDN hits, preflight, and access restrictions, so ensure this user is on the allowlist first:

```sh
node scripts/smoke.mjs https://YOUR-PROJECT.vercel.app
```

The script calls the real service and requires network access to Vercel. For protected candidate deployments, pass the project's automation access credential through the `SMOKE_BYPASS_SECRET` environment variable. Do not put credentials in command arguments or source code.

### Troubleshooting configuration errors (`INVALID_CONFIGURATION` / HTTP 500)

`INVALID_CONFIGURATION` means environment variable validation failed before any request was sent to GitHub. `details.field` identifies the setting, and `details.reason` explains the required correction. The corresponding log event is `configuration_error`, with `field` and `reason` at the top level. Tokens and other environment variable values are not logged.

The minimum configuration is `GITHUB_TOKEN` (a real token) and `GITHUB_ALLOWLIST=xaoxuu`. Configure these under Vercel project Settings → Environment Variables, select the current deployment environment (usually Production for the production domain), and redeploy. `.env.example` is not automatically used as production environment variables, and its empty `GITHUB_TOKEN` cannot be used as-is. Cache, timeout, and namespace settings fall back to valid defaults.

A correctly formatted but invalid or expired token usually produces `401` after a request to GitHub, which differs from a configuration error at startup.

## Caching and failure handling

### Cache flow

1. Vercel CDN serves fresh responses directly to reduce function invocations. Runtime Cache reuses regional data on CDN misses.
2. Cache keys include the project, deployment environment, configuration fingerprint, path, and sorted query parameters. The fingerprint includes the allowlist, a token hash, and cache/CORS settings. Client refreshes or extra headers do not force upstream requests.
3. After expiry, requests to GitHub include an ETag. A `304` reuses the body and updates the validation time; without an ETag, the body is fetched again. For a request returning fresh data, the CDN TTL does not exceed its remaining freshness period. Browsers use `max-age=0, must-revalidate`; other CDNs use `no-store`.
4. Identical requests are coalesced within one instance, and distinct upstream operations run serially. The queue holds at most 32 entries with a maximum wait of 5 seconds. The function is fixed to `iad1`, but multiple instances can still fetch concurrently. There is no distributed lock or strict global rate guarantee.
5. Confirmed rate limits share a cooldown deadline and retain instance-local state. The proxy respects `Retry-After` and the primary rate limit reset time. Without a valid time, it waits at least 60 seconds; consecutive secondary rate limits progressively extend the wait. No proactive retries occur during cooldown.

### Organization token policies and anonymous retries

When GitHub explicitly returns `403` because a PAT's lifetime exceeds an organization's maximum, repository requests retry once without Authorization. Redirects remain subject to the existing allowlist and redirect limits. This fallback applies to both repository visibility checks and content requests; anonymous results must still pass public visibility validation. After success, anonymous mode is remembered per repository for 5 minutes. Once it expires, upstream requests prefer the token again. Changing the token isolates previous fallback records. Switching authentication modes does not reuse the old ETag; successful data is cached normally.

Anonymous fallback does not apply to ordinary permission denials, SSO/IP restrictions, invalid tokens, rate limits, or `/rate_limit`. Token and anonymous requests track cooldowns separately. Anonymous quota is usually only 60 requests per egress IP per hour. Cooldown state is shared within the current project and deployment environment, with no global rate guarantee across projects or egress IPs. Logs record only a fixed reason for `github_anonymous_fallback` and the status code for `github_anonymous_result`, never the token or GitHub's original error body.

### Upstream failures and stale data

For `429`, upstream `5xx`, network failures, or queue overload, the proxy serves stale data within the allowed age when possible, with `no-store`. Without stale data, it returns `429`, `502`, or `503`. Ordinary `401/403/404` responses remove the corresponding cache entry and return the error directly. Other upstream `4xx` statuses are also preserved. None of these ordinary 4xx errors use stale fallback, and upstream error bodies are not forwarded.

### Response headers and cache limits

| Header | Description |
| --- | --- |
| `X-Proxy-Cache` | Application-level cache status: `MISS`, `HIT`, `REVALIDATED`, or `STALE` |
| `X-Proxy-Checked-At` | Time of the last successful data validation |
| `Retry-After` | Seconds until a retry is allowed, returned when applicable |

On CDN hits, these headers are snapshots from when the cached response was generated. Use Vercel's `x-vercel-cache` and `Age` to assess CDN hits.

Runtime Cache is regional, temporary, and subject to early eviction. Read/write failures log `cache_degraded` and fall back to an instance-local LRU cache capped at 256 entries and 16 MiB. A single GitHub response is limited to 768 KiB; larger responses return `502`, so reduce `per_page`. A `204` from the contributors endpoint for an empty repository remains an empty response.

GitHub's ordinary authenticated primary quota is usually 5000 requests per hour. Authenticated conditional requests returning `304` do not count against the primary quota, but secondary limits still apply. Throughput depends on the number of distinct requests, cache hit rate, and update frequency; unlimited requests are not guaranteed. Vercel CDN, functions, and caching have their own usage limits and billing. See [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [GitHub best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), and [Vercel Runtime Cache](https://vercel.com/docs/caching/runtime-cache).

## Local development

Requires Node.js 24 and npm.

```sh
npm ci
cp .env.example .env
# Edit .env and set GITHUB_TOKEN and GITHUB_ALLOWLIST.
npm run dev
```

The server runs at `http://localhost:3000` by default and uses a bounded in-memory cache. Restart it after changing `.env`.

Run `npm run check` for TypeScript checks and tests with a simulated upstream. No real token is needed, and tests do not access GitHub.
