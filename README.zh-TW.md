# gh-api

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

[![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat&logo=vercel&logoColor=white)](#vercel-部署)

基於 Node.js 和 TypeScript 的 GitHub 只讀 API 代理，可直接部署到 Vercel。前端通過代理存取白名單內的公開資源，無需持有 GitHub Token。

- **按需開放資源**：支援按使用者、組織或單個儲存庫設定白名單。
- **減少 GitHub 請求**：結合 Vercel CDN、區域 Runtime Cache、ETag 條件請求和實例內請求合併重用資料。
- **便於前端接入**：保留 GitHub JSON 結構，提供 CORS、分頁連結和統一錯誤回應。
- **部署簡單**：無需資料庫、Redis 或定時任務。

[快速開始](#快速開始) · [支援的端點](#支援的端點) · [錯誤回應](#錯誤回應) · [環境變數](#環境變數) · [部署維護與排查](#部署維護與排查) · [快取與異常處理](#快取與異常處理) · [本地開發](#本地開發)

## 快速開始

### Vercel 部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fxaoxuu%2Fgh-api&env=GITHUB_TOKEN%2CGITHUB_ALLOWLIST&envLink=https%3A%2F%2Fgithub.com%2Fxaoxuu%2Fgh-api%2Fblob%2Fmain%2FREADME.zh-TW.md%23%E7%92%B0%E5%A2%83%E8%AE%8A%E6%95%B8&project-name=gh-api&repository-name=gh-api)

點擊 **Deploy with Vercel** 按鈕，即可克隆儲存庫並創建 Vercel 專案。部署流程會提示填寫 `GITHUB_TOKEN` 和 `GITHUB_ALLOWLIST`，設定說明見[環境變數](#環境變數)。也可以按以下步驟手動導入：

1. 將儲存庫導入 Vercel，Framework Preset 選擇 **Other**，Node.js 選擇 **24.x**。專案已設定構建命令、`public` 輸出目錄、API 路由和單區域函數。
2. 在 Production 環境設定[環境變數](#環境變數)。只需設定 `GITHUB_TOKEN`、`GITHUB_ALLOWLIST`，快取命名空間預設使用專案 ID。Preview 若需測試應單獨設定環境變數。
3. 部署後使用生成的域名。專案不需要資料庫、Redis、定時任務或管理頁面。

### 設定白名單

```dotenv
GITHUB_ALLOWLIST=xaoxuu,vercel/next.js
```

| 寫法 | 授權範圍 |
| --- | --- |
| `owner` | 該 owner 的公開資料、公開儲存庫列表，以及全部公開儲存庫的受支援端點，包括以後新建的儲存庫 |
| `owner/repo` | 僅該儲存庫的受支援端點，不授權 owner 資料、儲存庫列表或其他儲存庫 |

規則忽略大小寫，自動去除首尾空白和重復項，多條規則共同生效。匹配時使用完整名稱，不做前綴匹配。

白名單為空時，拒絕所有需要 owner 或儲存庫授權的請求；`/` 和 `/rate_limit` 不受白名單限制。空條目、通配符或額外路徑等格式錯誤會導致設定驗證失敗。

### 前端呼叫

```js
const response = await fetch(
  'https://YOUR-PROJECT.vercel.app/repos/vercel/next.js/issues?state=open&per_page=20&page=1'
);
if (!response.ok) throw new Error(`GitHub proxy: ${response.status}`);
const issues = await response.json();
console.log(issues, response.headers.get('X-Proxy-Cache'));
```

成功回應保留 GitHub JSON 結構。分頁不會自動聚合，`Link` 回應頭中的 GitHub 地址會改寫為 `/...` 相對地址；前端應以代理域名解析它，例如 `new URL(nextPath, 'https://YOUR-PROJECT.vercel.app')`。JSON 內的 `url` 等欄位保持原樣，繼續請求時應使用下表中的代理端點。

## 支援的端點

代理僅開放以下端點，支援 `GET`、`HEAD` 和 `OPTIONS`。

### 入口與額度

| 路徑 | 說明 |
| --- | --- |
| `/` | 返回 GitHub API 入口 JSON，保留其中的 GitHub 原始連結 |
| `/rate_limit` | 返回服務端 Token 的額度資訊，最多快取 5 秒，不使用過期資料兜底，冷卻期間遵守重試時間 |

這兩個入口無需匹配白名單，僅接受並移除 `_`、`timestamp` 參數。入口 JSON 中的連結不代表代理支援所有 GitHub 端點。

### 使用者、組織與儲存庫

| GitHub 路徑 | 支援查詢參數 |
| --- | --- |
| `/users/:owner` | 無 |
| `/users/:owner/repos` | `page`, `per_page`, `type`, `sort`, `direction` |
| `/users/:owner/followers`、`/users/:owner/following`、`/users/:owner/orgs`、`/users/:owner/subscriptions` | `page`, `per_page` |
| `/users/:owner/starred` | `page`, `per_page`, `sort`, `direction` |
| `/orgs/:owner` | 無 |
| `/orgs/:owner/repos` | `page`, `per_page`, `type`, `sort`, `direction` |
| `/repos/:owner/:repo` | 無 |
| `/repos/:owner/:repo/issues` | `page`, `per_page`, `state`, `labels`, `sort`, `direction`, `since`, `creator`, `mentioned`, `assignee`, `milestone`, `type`, `issue_field_values` |
| `/repos/:owner/:repo/issues/:number` | 無 |
| `/repos/:owner/:repo/issues/:number/comments` | `page`, `per_page`, `since` |
| `/repos/:owner/:repo/issues/comments` | `page`, `per_page`, `since`, `sort`, `direction` |
| `/repos/:owner/:repo/issues/comments/:id` | 無 |
| `/repos/:owner/:repo/releases` | `page`, `per_page` |
| `/repos/:owner/:repo/tags` | `page`, `per_page` |
| `/repos/:owner/:repo/releases/latest`、`/repos/:owner/:repo/releases/:id` | 無 |
| `/repos/:owner/:repo/contributors` | `page`, `per_page`, `anon`；兼容 `direction=asc/desc`（忽略） |
| `/repos/:owner/:repo/stargazers`、`/repos/:owner/:repo/subscribers` | `page`, `per_page` |
| `/repos/:owner/:repo/forks` | `page`, `per_page`, `sort` |
| `/repos/:owner/:repo/branches` | `page`, `per_page`, `protected` |
| `/repos/:owner/:repo/commits` | `page`, `per_page`, `sha`, `path`, `author`, `committer`, `since`, `until` |
| `/repos/:owner/:repo/languages` | 無 |
| `/repos/:owner/:repo/topics` | `page`, `per_page` |
| `/repos/:owner/:repo/labels`、`/repos/:owner/:repo/issues/:number/labels` | `page`, `per_page` |
| `/repos/:owner/:repo/milestones` | `page`, `per_page`, `state`, `sort`, `direction` |
| `/repos/:owner/:repo/milestones/:number` | 無 |
| `/repos/:owner/:repo/pulls` | `page`, `per_page`, `state`, `head`, `base`, `sort`, `direction` |
| `/repos/:owner/:repo/pulls/:number` | 無 |

### 請求與參數規則

`HEAD` 重用 `GET` 的公開性檢查、授權和快取邏輯，僅省略回應正文；冷快取時仍需通過 `GET` 回源。CORS 預檢允許 `Accept`、`Content-Type` 和 `X-Requested-With`，這些用戶端請求頭不會原樣轉發給 GitHub。

- **分頁**：`per_page` 為 1–100，`page` 為 1–10000；允許前導零，並規範化為普通整數。
- **時間**：`since` 和 `until` 使用 UTC 格式 `YYYY-MM-DDTHH:mm:ssZ`。
- **枚舉**：允許值以對應端點的驗證規則為準，部分端點的特殊規則見下文。
- **快取參數**：所有入口統一移除 `_` 和 `timestamp`，它們不參與 Runtime Cache 鍵。
- **輸入限制**：拒絕未知參數、重復參數、編碼路徑段和任意上游 URL。

搜索、文件內容、GraphQL、寫端點和當前登錄身份 `/user` 不在支援範圍內。GitHub Issues 列表可能包含 Pull Request，這是 GitHub 的原始行為。

### 部分端點的特殊規則

owner 可為使用者或組織名稱。`/users` 和 `/orgs` 下的端點需要 owner 級白名單授權。組織儲存庫列表預設只查詢公開儲存庫，`type` 可選 `public`、`forks`、`sources`。Stargazers 使用 GitHub 預設的使用者列表格式；Watchers 對應 `/subscribers`。Branches 和 Commits 提供列表端點。

- **Contributors**：固定按貢獻數降序返回。兼容參數 `direction=asc/desc` 會在驗證後移除，不改變排序，並與不帶該參數的請求共用 Runtime Cache。
- **Forks**：`sort` 支援 `newest`、`oldest`、`stargazers` 和 `watchers`。
- **Issues**：`type` 接受類型名稱、`*` 或 `none`；`issue_field_values` 接受 `priority:Urgent` 等欄位篩選，需儲存庫啓用對應欄位。這些規則不適用於組織儲存庫列表的 `type`。

參數規範化僅合併 Runtime Cache 和回源請求；不同原始 URL 的 Vercel CDN 快取仍可能分開。參數規範化不會繞過公開性檢查、白名單、端點限制、輸入長度限制或限流策略。

## 錯誤回應

應用返回的錯誤統一使用以下 JSON 結構，HTTP 狀態碼與 `status` 一致，且禁止快取：

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

前端先用 `response.ok` 判斷請求是否成功，再按 `code` 處理錯誤；`message` 僅用於展示，不用於判斷錯誤類型。錯誤 JSON 均包含上述六個欄位，`details` 無額外資訊時為 `null`，`retryAfter` 無重試時間時為 `null`，否則為秒數，與 `Retry-After` 回應頭一致。成功回應仍為 GitHub 原始 JSON；`204` 和 `HEAD` 回應均無正文。

| code | 含義 |
| --- | --- |
| `INVALID_REQUEST` | 路徑、查詢參數或預檢請求頭不合法 |
| `FORBIDDEN` | 白名單、Origin 或公開儲存庫限制拒絕存取 |
| `UNSUPPORTED_ENDPOINT` | 不支援的端點 |
| `METHOD_NOT_ALLOWED` | 不支援的 HTTP 方法 |
| `UPSTREAM_REQUEST_FAILED` | GitHub 請求失敗，普通 `4xx` 保留原狀態（限流單獨處理）；其他異常狀態映射為 502 |
| `RATE_LIMITED` | GitHub 限流或冷卻中 |
| `UPSTREAM_ERROR` | GitHub 服務異常、網絡/逾時、回應格式或大小異常 |
| `SERVICE_UNAVAILABLE` | 上游隊列已滿或等待逾時 |
| `INVALID_CONFIGURATION` | 服務設定異常，`details` 包含安全的 `field` 和 `reason`（未知原因時為 `null`） |
| `INTERNAL_ERROR` | 代理內部異常 |

## 環境變數

設定 `GITHUB_TOKEN` 和 `GITHUB_ALLOWLIST` 即可開始使用，其餘設定均可省略。

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 必填 | GitHub fine-grained PAT，Repository access 選擇 **Public repositories (read-only)**；不要授予私有儲存庫權限 |
| `GITHUB_ALLOWLIST` | 空 | 逗號分隔的 owner 或 owner/repo |
| `CACHE_TTL_SECONDS` | `1800` | 新鮮期，1–86400 秒 |
| `CACHE_MAX_AGE_SECONDS` | `86400` | 上游故障時可返回的資料最大年齡，從上次成功驗證起計算；不得小於新鮮期，最多 604800 秒 |
| `CACHE_NAMESPACE` | Vercel 專案 ID，本地 `gh-api` | 快取命名空間，建議每個專案使用不同值 |
| `CACHE_VERSION` | `1` | 手動切換 Runtime Cache 版本，修改後重新部署 |
| `CORS_ORIGINS` | `*` | 未設定或空值使用預設值；或逗號分隔的 HTTP(S) Origin，例如 `https://example.com,http://localhost:5173`。自動去除首尾空白、尾部斜槓並規範化域名大小寫及預設連接埠；不接受路徑、查詢參數或帳號密碼 |
| `GITHUB_TIMEOUT_MS` | `10000` | 一次回源工作（包含公開性檢查和重新導向）的逾時，100–15000 毫秒 |
| `PORT` | `3000` | 僅本地服務 |

### 預設值與驗證

快取和逾時參數會去除首尾空白；空值、非整數或超出表中範圍時，自動使用預設值。`CACHE_MAX_AGE_SECONDS` 小於實際新鮮期時，也會回退到 86400 秒。

非法或空的 `CACHE_NAMESPACE` 使用專案 ID（本地為 `gh-api`），空 `CACHE_VERSION` 使用 `1`。Token、白名單和顯式設定的 CORS 規則會嚴格驗證，避免錯誤設定意外擴大存取範圍。

### Token 與存取邊界

Token 永不返回前端，也不記錄在日誌中。用戶端 Authorization、Cookie 和自訂 Accept 不會傳給 GitHub。儲存庫資訊必須明確為 `private: false`；儲存庫子端點回源前先檢查並快取儲存庫公開性，防止 Token 權限誤配導致讀取私有儲存庫。存取控制和公開性檢查反映快取時點，GitHub 上的可見性變化可能在新鮮期結束後才被發現，因此仍應使用僅公開資源 Token。

CORS 是瀏覽器跨域策略，不是身份認證；沒有 Origin 的服務端呼叫仍可存取白名單內資源。請勿在前端嵌入所謂“秘密 API Key”。

## 部署維護與排查

### 白名單撤銷與舊部署

環境變數是部署快照，**只編輯 Vercel 環境變數不會改變運行中的部署**。修改白名單、Token、CORS 或 TTL 後，必須重新部署並將新部署切換到生產域名。

新部署有獨立 CDN 快取鍵；新的設定指紋隔離原來的 Runtime Cache，所以生產域名不再重用舊授權回應。舊部署的獨立 URL 仍使用舊白名單，必須通過 Deployment Protection 限制存取或刪除舊部署，才算完成所有地址的撤權。回滾舊部署同樣會恢復舊設定，需要重新部署當前設定。詳見 [Vercel CDN 快取鍵](https://vercel.com/docs/caching/cdn-cache/purge)。

### 部署後驗收

```sh
curl -i 'https://YOUR-PROJECT.vercel.app/repos/vercel/next.js'
# 再次請求相同 URL，檢查 x-vercel-cache: HIT；也可使用 curl -I 驗證 HEAD 回應
curl -i 'https://YOUR-PROJECT.vercel.app/repos/vercel/next.js'
curl -i -H 'Origin: https://example.com' 'https://YOUR-PROJECT.vercel.app/repos/vercel/next.js/issues?per_page=1'
```

- 驗證第二次請求 CDN 命中，並確認 Runtime 日誌中沒有新增同資源回源。
- 檢查分頁 `Link` 指向代理；檢查預設或設定後的 CORS 行為。
- 請求白名單外儲存庫應返回 `403`，POST 應返回 `405`。
- 撤銷一條規則並重新部署後，原 URL 應返回 `403`，同時檢查舊部署已保護或刪除。

自動測試覆蓋應用層快取隔離與回應頭；真實 CDN 命中、部署 rewrite 和舊部署存取限制需要在部署後按以上步驟驗收。本專案不會在本地測試過程中自動發佈。

也可運行在線驗收腳本。腳本以白名單使用者 `xaoxuu` 驗證資料、分頁、CDN 命中、預檢和存取限制，請先確保白名單包含該使用者：

```sh
node scripts/smoke.mjs https://YOUR-PROJECT.vercel.app
```

腳本會請求真實服務，需在可存取 Vercel 的網絡中運行。受保護的候選部署可通過環境變數 `SMOKE_BYPASS_SECRET` 傳入專案的自動化存取憑證，請勿將憑證寫入命令參數或源碼。

### 排查設定錯誤（`INVALID_CONFIGURATION` / HTTP 500）

回應代碼 `INVALID_CONFIGURATION` 表示環境變數驗證失敗，請求尚未發送到 GitHub。`details.field` 指出設定項，`details.reason` 給出修正要求。日誌中對應的事件為 `configuration_error`，其中 `field` 和 `reason` 位於頂層，不會輸出 Token 或其他環境變數值。

最小設定是 `GITHUB_TOKEN`（填寫真實 Token）和 `GITHUB_ALLOWLIST=xaoxuu`。在 Vercel 專案 Settings → Environment Variables 中設定，確認勾選當前部署環境（生產域名通常為 Production），然後重新部署。`.env.example` 不會自動成為線上環境變數，其中空的 `GITHUB_TOKEN` 也不能直接使用。快取、逾時及命名空間參數會自動回退到有效預設值。

無效或過期但格式正確的 Token 通常會在請求 GitHub 後得到 `401`，與啓動時的設定錯誤不同。

## 快取與異常處理

### 快取流程

1. Vercel CDN 直接服務新鮮回應，減少函數呼叫；Runtime Cache 在 CDN 未命中時重用區域資料。
2. 快取鍵包含專案、部署環境、設定指紋、路徑和排序後的查詢參數。指紋包含白名單、Token 的哈希和快取/CORS 設定。用戶端刷新或添加請求頭不會強制回源。
3. 過期後攜帶 ETag 請求 GitHub；`304` 重用正文並更新驗證時間。沒有 ETag 時重新讀取正文。一次返回新資料的請求，CDN TTL 不超過該資料剩餘新鮮期；瀏覽器使用 `max-age=0, must-revalidate`，其他 CDN 使用 `no-store`。
4. 單實例相同請求合併，不同回源串行執行。隊列最多 32 項，等待最多 5 秒。函數固定 `iad1`，多實例仍可能同時回源；不提供分布式鎖或嚴格全局速率保證。
5. 確認限流後共享冷卻截止時間並保留實例內狀態；遵守 `Retry-After` 和主額度重置時間，無有效時間時至少等待 60 秒，連續二級限流逐次延長等待。冷卻期間不主動重試。

### 組織 Token 策略與匿名重試

儲存庫請求遇到 GitHub 明確返回“PAT 有效期超過組織上限”的 `403` 時，移除 Authorization 匿名重試一次（重新導向仍受原有白名單和次數限制）。儲存庫公開性檢查和內容請求均支援此兜底；匿名結果仍須通過公開性驗證。成功後按儲存庫記住匿名模式 5 分鐘，到期後的回源重新優先使用 Token；更換 Token 會隔離舊的降級記錄。切換認證方式不重用原 ETag，成功資料照常快取。

匿名兜底不適用於普通權限拒絕、SSO/IP 限制、無效 Token、限流或 `/rate_limit`。Token 與匿名請求分別記錄冷卻時間；匿名額度通常僅每出口 IP 每小時 60 次，冷卻狀態在當前專案和部署環境內共享，不保證跨專案或跨出口的全局限流。日誌只記錄 `github_anonymous_fallback` 的固定原因以及 `github_anonymous_result` 的狀態碼，不記錄 Token 或 GitHub 原始錯誤正文。

### 上游故障與舊資料

`429`、上游 `5xx`、網絡失敗或隊列過載時，盡可能返回允許年齡內的舊資料，且回應 `no-store`。沒有舊資料則返回 `429`、`502` 或 `503`。普通 `401/403/404` 會移除對應快取，直接返回錯誤；其他上游 `4xx` 也保留原狀態，均不使用舊資料兜底，不轉發上游錯誤正文。

### 回應頭與快取限制

| 回應頭 | 說明 |
| --- | --- |
| `X-Proxy-Cache` | 應用層快取狀態：`MISS`、`HIT`、`REVALIDATED` 或 `STALE` |
| `X-Proxy-Checked-At` | 資料上次成功驗證的時間 |
| `Retry-After` | 距離可重試時間的秒數，按需返回 |

CDN 命中時，這些回應頭是生成快取時的快照。判斷 CDN 是否命中，應結合 Vercel 的 `x-vercel-cache` 和 `Age`。

Runtime Cache 為區域性、可提前淘汰的臨時快取。讀寫失敗記錄 `cache_degraded`，回退到最多 256 項、16 MiB 的實例內 LRU 快取。單個 GitHub 回應限制為 768 KiB，超出時返回 `502`，請減小 `per_page`。空儲存庫貢獻者端點的 `204` 保持空回應。

GitHub 普通認證主額度通常為每小時 5000 次；認證條件請求的 `304` 不計主額度，但二級限流仍有效。吞吐量取決於不同請求數量、命中率和更新頻率，不承諾無限請求。Vercel CDN/函數/快取仍有自身用量和計費。參考 [GitHub 限流](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[GitHub 最佳實踐](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)、[Vercel Runtime Cache](https://vercel.com/docs/caching/runtime-cache)。

## 本地開發

需要 Node.js 24 和 npm。

```sh
npm ci
cp .env.example .env
# 編輯 .env，設定 GITHUB_TOKEN 和 GITHUB_ALLOWLIST
npm run dev
```

服務預設運行在 `http://localhost:3000`，使用有容量上限的記憶體快取。修改 `.env` 後需重啓服務。

運行 `npm run check` 可執行 TypeScript 檢查和模擬上游測試，無需真實 Token，也不會存取 GitHub。
