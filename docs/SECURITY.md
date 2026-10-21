# 上线前安全检查（第七阶段 · 任务一）

检查范围：所有会被提交的文件、所有会产生费用的端点、高德安全代理的转发面、以及日志与截图里的凭据痕迹。
下面每一条要么给出代码位置，要么给出今天的实测响应，不写「应该没问题」。

---

## 1. 凭据边界

| 变量 | 谁能看到 | 落点 |
| --- | --- | --- |
| `AMAP_JS_KEY` | **浏览器**（JS API 类型 key 设计上必须交给浏览器加载 SDK） | 只出现在高德 SDK 的 script 地址里 |
| `AMAP_JS_SECURITY_CODE` | 只有服务端 | 在 `/amap-proxy` 里才拼进上游请求（`src/lib/server/amap-js.ts:129`） |
| `AMAP_WEB_KEY` / `FLYAI_API_KEY` / `DASHSCOPE_API_KEY` / `BAILIAN_*` | 只有服务端 | 环境变量，不进任何响应体 |

- 九个变量**全部没有 `NEXT_PUBLIC_` 前缀** → 不会被打进浏览器 bundle。
- `.env.local` 被 `.gitignore` 的 `.env*` 规则忽略，仓库里只有 `.env.example`（只有变量名，值为空）。
- 验收套件会把 `.env.local` 里的真实值拿来在页面 HTML 与文本节点里做包含检查（`evidence/phase6-accept.mjs` 末尾两项）。跑线上时本地没有 `.env.local`，这两项自动跳过并在日志里说明原因——因为线上凭据在平台环境变量里，本来就没有可比对的明文。

## 2. 必须先做、且尚未完成的一件事：轮换高德 JS 凭据

开发过程中，高德 **JS API Key 与 JS 安全密钥曾被整串贴进对话**。这两个值应当按「已经泄露」处理：

1. 到高德控制台**重置安全密钥**（`AMAP_JS_SECURITY_CODE`）；
2. 必要时**换一个新的 JS API Key**；
3. 同时给新 key 配上**域名白名单**与**每日配额**（见第 4 节的残余风险）。

轮换并在你确认之前，本仓库的 README 与本文都保留这条提醒，**不会**出现「密钥安全问题已彻底解决」这类说法。

## 3. 提交物里有什么、没什么

扫描方式（可复跑）：按凭据形状搜全部可提交文件 —— 30–34 位十六进制、`sk-`、`agent_`、`env_`、`ws-` 前缀。

命中并已处理：

| 命中 | 处置 |
| --- | --- |
| `scripts/agent-v1-backup.json`：百炼 Agent 配置快照，含真实 `workspace_id` 与 `agent id`（账户标识） | 已在 `.gitignore`，不入库 |
| `evidence/*probe*.mjs`：一次性探针，写死本机 Playwright 路径 | 已忽略；保留下来的是可复跑的 `evidence/phase6-accept.mjs` |
| `tsconfig.tsbuildinfo`、`.next/`、`node_modules/`、`evidence/start.log` | 已忽略 |
| 历史探针截图（`phase6-01…04`、`11…14`、`map-01`、`phase6-map-real`） | 不入库；仓库只保留当前验收套件产出的 6 张，逐张人工看过：地图 + 面板文案，没有 key、没有 id、没有 URL 带密钥 |

日志侧：

- 服务端状态端点只输出掩码：`keyMask`（`96d9****5c`）、`sk-w****-c`、`hostMasked`、`agentIdMasked`、`environmentIdMasked`。
- `/api/discover` 曾经把 CLI 入口的**绝对路径**（含 Windows 用户名）回出来，现在统一走 `describeCliEntry()` → 只剩 `node_modules\@fly-ai\flyai-cli\dist\flyai-bundle.cjs` 这种相对路径。
- 子进程环境变量改成白名单（`buildChildEnv()`）：之前是把整个 `process.env` 传给第三方混淆包，云端那里面装着全部凭据。
- 服务端**不落盘**调用日志，只有进程内数组 → 没有日志泄密面，代价是无法事后审计。

## 4. 高德安全代理不是开放代理

实现见 `src/lib/server/amap-js.ts`，逐条今天实测：

| 约束 | 实测 |
| --- | --- |
| 上游主机固定（`restapi.amap.com`；只有 `v4/map` 样式走 `webapi.amap.com`），调用方无法指定主机 | 转发目标由代码拼，URL 里没有可注入的主位 |
| 只放行 `v3/v4/v5` 前缀 | `GET /amap-proxy/v2/whatever` → **400** `高德代理只转发 v3/v4/v5 开头的请求。` |
| 路径片段字符白名单 + 显式拒绝 `.`/`..` 点段 | `curl --path-as-is /amap-proxy/v5/../../etc/passwd` → **404**（Next 路由层就没匹配上，处理器的点段拒绝是第二层） |
| 带 `key` 的请求必须等于本站 JS key | `?key=deadbeef…` → **403** `高德代理拒绝了不属于本站 JS API Key 的请求。` |
| 只接受 GET / POST | 其他方法 → 405 |
| POST 体积 ≤ 256 KB（本次新增） | 300 KB 请求体 → **413** `高德代理只转发不超过 256 KB 的请求体。`（检查放在配额计数之前） |
| 每分钟 240 次、上游超时 12s、错误文本 scrub 掉密钥 | `PROXY_MINUTE_CAP` / `PROXY_TIMEOUT_MS` / `scrub()` |

**残余风险（不粉饰）**：JS API Key 天生是公开的——它就印在页面里。拿到它的人仍然可以通过本站代理以 ≤240 次/分钟 打高德，消耗的是本站配额。这和**高德官方 nginx 样例代理**的暴露面是一样的，代码层无法再收紧，剩下的两道闸在高德控制台：**域名白名单**与**每日配额**。这两项需要你在控制台确认已配（和第 2 节一起做）。

## 5. 会产生费用的端点

| 端点 | 费用来源 | 上限与护栏（全部在代码里） |
| --- | --- | --- |
| `/api/discover` | 飞猪 CLI 子进程 | 12 次/小时（`discover.ts:19`）+ 10 分钟分类缓存 + 单次 60s 超时后 kill |
| `/api/verify` | 高德 POI + 步行规划 | POI 40/小时、步行 80/小时（`amap.ts:32-33`）+ 6 小时结果缓存 + 30 分钟整条流水线缓存 + **串行节流**（个人 key 只有 2–3 QPS） |
| `/api/agent` | 百炼托管智能体回合 | 40 回合/小时（`bailian.ts:117`）+ **建会话之前**的只读预检（超限连会话都不建）+ 回合 90s 超时 + 同 token/intent/stop 在飞行中去重 |
| `/amap-proxy/*` | 高德 JS 服务配额 | 240 次/分钟 + 256 KB + 第 4 节全部白名单 |
| `GET /api/verify`、`/api/agent`、`/api/discover`、`/api/map-config` | 无 | 只回掩码状态与计数，不触发外部调用 |

滥用面还做了：请求体 ≤ 8 KB（超出 413）、`stopId`/`token` ≤ 64 字符、`interests` 白名单、未知 `stopId` 在花钱之前就拒绝。

**诚实的边界**：这些计数与缓存都是**进程内**的。单机常驻 = 语义正确；serverless 多实例 = 每个实例各算各的，上限会被实例数放大。部署方式必须和这张表配套，见 [docs/DEPLOYMENT.md](DEPLOYMENT.md)。

## 6. 没有做的事（避免读的人误以为已经做了）

- **没有账号体系** → 限流只有全局小时上限，没有「按访客」维度。公开部署后任何访客都能消耗额度，上限就是为此存在。
- **没有给 `/api/*` 加鉴权**：这是要给评委直接点开的演示项目，加登录就把演示废掉了。兜底手段是上面那张上限表。
- **HTTPS / HSTS 不在本仓库配置**，由部署平台负责。
- **调用日志不持久化** → 无法事后对账；要审计必须引入外部存储，本次没做。
- **高德凭据轮换**：等你确认。
