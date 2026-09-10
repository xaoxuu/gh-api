# gh-api

可部署到 Vercel 的 Node.js + TypeScript GitHub 只读 API 代理。前端无需接触 GitHub Token；通过 CDN、区域 Runtime Cache、ETag 条件请求和实例内请求合并降低 GitHub 回源量。

## 本地运行

需要 Node.js 24 和 npm。

```sh
npm ci
cp .env.example .env
# 编辑 .env，设置 GITHUB_TOKEN 和 GITHUB_ALLOWLIST
npm run dev
```

本地地址为 `http://localhost:3000`，使用有容量上限的内存缓存。修改环境变量后重启。`npm run check` 执行 TypeScript 检查及模拟上游测试，不需要真实 Token，不访问 GitHub。

## 白名单

```dotenv
GITHUB_ALLOWLIST=xaoxuu,vercel/next.js
```

| 写法 | 授权范围 |
| --- | --- |
| `owner` | 该 owner 的公开资料、公开仓库列表，以及全部公开仓库的受支持接口，包括以后新建的仓库 |
| `owner/repo` | 仅该仓库的受支持接口，不授权 owner 资料、仓库列表或其他仓库 |

规则忽略大小写，去除首尾空白、去重、取并集。空白名单拒绝全部代理请求；空条目、通配符、额外路径等格式错误会导致配置校验失败。匹配完整名称，不使用前缀匹配。

## 前端调用

```js
const response = await fetch(
  'https://YOUR-PROJECT.vercel.app/repos/vercel/next.js/issues?state=open&per_page=20&page=1'
);
if (!response.ok) throw new Error(`GitHub proxy: ${response.status}`);
const issues = await response.json();
console.log(issues, response.headers.get('X-Proxy-Cache'));
```

成功响应保留 GitHub JSON 结构。分页不会自动聚合，`Link` 响应头中的 GitHub 地址会改写为 `/...` 相对地址；前端应以代理域名解析它，例如 `new URL(nextPath, 'https://YOUR-PROJECT.vercel.app')`。JSON 内的 `url` 等字段保持原样，继续请求时应使用下表中的代理接口。

直接使用以下根路径，无需添加 `/api/github` 等前缀：

| GitHub 路径 | 支持查询参数 |
| --- | --- |
| `/users/:owner` | 无 |
| `/users/:owner/repos` | `page`, `per_page`, `type`, `sort`, `direction` |
| `/repos/:owner/:repo` | 无 |
| `/repos/:owner/:repo/issues` | `page`, `per_page`, `state`, `labels`, `sort`, `direction`, `since`, `creator`, `mentioned`, `assignee`, `milestone` |
| `/repos/:owner/:repo/issues/:number` | 无 |
| `/repos/:owner/:repo/issues/:number/comments` | `page`, `per_page`, `since` |
| `/repos/:owner/:repo/issues/comments` | `page`, `per_page`, `since`, `sort`, `direction` |
| `/repos/:owner/:repo/issues/comments/:id` | 无 |
| `/repos/:owner/:repo/releases` | `page`, `per_page` |
| `/repos/:owner/:repo/releases/latest`、`/releases/:id` | 无 |
| `/repos/:owner/:repo/contributors` | `page`, `per_page`, `anon` |

仅接受 `GET` 和 `OPTIONS`。`per_page` 为 1–100，`page` 为 1–10000；`since` 使用 UTC 格式 `YYYY-MM-DDTHH:mm:ssZ`。其他枚举遵循对应 GitHub 接口；不接受重复参数、随机缓存破坏参数、编码路径段或任意上游 URL。搜索、文件内容、GraphQL、写接口和当前登录身份 `/user` 不在支持范围内。GitHub Issues 列表可能包含 Pull Request，这是 GitHub 原始行为。

owner 可为用户或组织名称。组织的仓库接口正常支持；资料和仓库列表使用 GitHub `/users/:owner` 系列端点，不额外提供 `/orgs` 接口。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 必填 | GitHub fine-grained PAT，Repository access 选择 **Public repositories (read-only)**；不要授予私有仓库权限 |
| `GITHUB_ALLOWLIST` | 空 | 逗号分隔的 owner 或 owner/repo |
| `CACHE_TTL_SECONDS` | `1800` | 新鲜期，1–86400 秒 |
| `CACHE_MAX_AGE_SECONDS` | `86400` | 上游故障时可返回的数据最大年龄，从上次成功校验起计算；不得小于新鲜期，最多 604800 秒 |
| `CACHE_NAMESPACE` | Vercel 项目 ID，本地 `gh-api` | 缓存命名空间，建议每个项目使用不同值；示例文件为 `gh-api` |
| `CACHE_VERSION` | `1` | 手动切换 Runtime Cache 版本，修改后重新部署 |
| `CORS_ORIGINS` | `*` | 或逗号分隔的精确 Origin，例如 `https://example.com,http://localhost:5173`，不能带尾部斜杠 |
| `GITHUB_TIMEOUT_MS` | `10000` | 一次回源工作（包含公开性检查和重定向）的超时，100–15000 毫秒 |
| `PORT` | `3000` | 仅本地服务 |

Token 永不返回前端，也不记录在日志中。客户端 Authorization、Cookie 和自定义 Accept 不会传给 GitHub。仓库信息必须明确为 `private: false`；仓库子接口回源前先检查并缓存仓库公开性，防止 Token 权限误配导致读取私有仓库。访问控制和公开性检查反映缓存时点，GitHub 上的可见性变化可能在新鲜期结束后才被发现，因此仍应使用仅公开资源 Token。

CORS 是浏览器跨域策略，不是身份认证；没有 Origin 的服务端调用仍可访问白名单内资源。请勿在前端嵌入所谓“秘密 API Key”。

## 缓存及异常行为

1. Vercel CDN 直接服务新鲜响应，减少函数调用；Runtime Cache 在 CDN 未命中时复用区域数据。
2. 缓存键包含项目、部署环境、配置指纹、路径和排序后的查询参数。指纹包含白名单、Token 的哈希和缓存/CORS 配置。客户端刷新或添加请求头不会强制回源。
3. 过期后携带 ETag 请求 GitHub；`304` 复用正文并更新校验时间。没有 ETag 时重新读取正文。一次返回新数据的请求，CDN TTL 不超过该数据剩余新鲜期；浏览器使用 `max-age=0, must-revalidate`，其他 CDN 使用 `no-store`。
4. 单实例相同请求合并，不同回源串行执行。队列最多 32 项，等待最多 5 秒。函数固定 `iad1`，多实例仍可能同时回源；不提供分布式锁或严格全局速率保证。
5. 确认限流后共享冷却截止时间并保留实例内状态；遵守 `Retry-After` 和主额度重置时间，无有效时间时至少等待 60 秒，连续二级限流逐次延长等待。冷却期间不主动重试。
6. `429`、上游 `5xx`、网络失败或队列过载时，尽可能返回允许年龄内的旧数据，且响应 `no-store`。没有旧数据则返回 `429`、`502` 或 `503`。普通 `401/403/404` 会移除对应缓存，直接返回错误；不转发上游错误正文。

响应头：`X-Proxy-Cache` 为 `MISS`、`HIT`、`REVALIDATED` 或 `STALE`；`X-Proxy-Checked-At` 为成功校验时间，`Retry-After` 为可重试秒数。CDN 命中时这些头是生成缓存时的快照，应结合 Vercel 的 `x-vercel-cache` 和 `Age` 判断实际 CDN 命中。

Runtime Cache 为区域性、可提前淘汰的临时缓存。读写失败记录 `cache_degraded`，回退到最多 256 项、16 MiB 的实例内 LRU 缓存。单个 GitHub 响应限制为 768 KiB，超出时返回 `502`，请减小 `per_page`。空仓库贡献者接口的 `204` 保持空响应。

GitHub 普通认证主额度通常为每小时 5000 次；认证条件请求的 `304` 不计主额度，但二级限流仍有效。吞吐量取决于不同请求数量、命中率和更新频率，不承诺无限请求。Vercel CDN/函数/缓存仍有自身用量和计费。参考 [GitHub 限流](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[GitHub 最佳实践](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)、[Vercel Runtime Cache](https://vercel.com/docs/caching/runtime-cache)。

## Vercel 部署

1. 将仓库导入 Vercel，Framework Preset 选择 **Other**，Node.js 选择 **24.x**。项目已配置构建命令、`public` 输出目录、API rewrite 和单区域函数。
2. 在 Production 环境配置上表变量。至少设置 `GITHUB_TOKEN`、`GITHUB_ALLOWLIST`；项目间使用不同 `CACHE_NAMESPACE`。Preview 若需测试应单独配置环境变量。
3. 部署后使用生成的域名。项目不需要数据库、Redis、定时任务或管理页面。

### 排查 `configuration_error` / HTTP 500

这表示环境变量校验失败，请求尚未发送到 GitHub。日志和 JSON 响应中的 `field` 会指出配置项，`reason` 给出修正要求；不会输出 Token 或其他环境变量值。

最小配置是 `GITHUB_TOKEN`（填写真实 Token）和 `GITHUB_ALLOWLIST=xaoxuu`。在 Vercel 项目 Settings → Environment Variables 中配置，确认勾选当前部署环境（生产域名通常为 Production），然后重新部署。`.env.example` 不会自动成为线上环境变量，其中空的 `GITHUB_TOKEN` 也不能直接使用。可选变量不需要时直接删除，不要填空字符串。

旧版本如果只打印 `{ "event": "configuration_error" }`，请部署此版本以查看具体配置项。仅凭旧日志无法确定是哪一项错误。无效或过期但格式正确的 Token 通常会在请求 GitHub 后得到 `401`，与启动时的配置错误不同。

### 白名单撤销与旧部署

环境变量是部署快照，**只编辑 Vercel 环境变量不会改变运行中的部署**。修改白名单、Token、CORS 或 TTL 后，必须重新部署并将新部署切换到生产域名。

新部署有独立 CDN 缓存键；新的配置指纹隔离原来的 Runtime Cache，所以生产域名不再复用旧授权响应。旧部署的独立 URL 仍使用旧白名单，必须通过 Deployment Protection 限制访问或删除旧部署，才算完成所有地址的撤权。回滚旧部署同样会恢复旧配置，需要重新部署当前配置。详见 [Vercel CDN 缓存键](https://vercel.com/docs/caching/cdn-cache/purge)。

不要把“清空缓存”当作更改授权：旧部署仍会按旧规则重新获取数据。

### 部署后验收

```sh
curl -i 'https://YOUR-PROJECT.vercel.app/repos/vercel/next.js'
# 再次请求相同 URL，检查 x-vercel-cache: HIT；不要使用 curl -I（HEAD 不支持）
curl -i 'https://YOUR-PROJECT.vercel.app/repos/vercel/next.js'
curl -i -H 'Origin: https://example.com' 'https://YOUR-PROJECT.vercel.app/repos/vercel/next.js/issues?per_page=1'
```

- 验证第二次请求 CDN 命中，并确认 Runtime 日志中没有新增同资源回源。
- 检查分页 `Link` 指向代理；检查默认或配置后的 CORS 行为。
- 请求白名单外仓库应返回 `403`，POST 应返回 `405`。
- 撤销一条规则并重新部署后，原 URL 应返回 `403`，同时检查旧部署已保护或删除。

自动测试覆盖应用层缓存隔离与响应头；真实 CDN 命中、部署 rewrite 和旧部署访问限制需要在部署后按以上步骤验收。本项目不会在本地测试过程中自动发布。
