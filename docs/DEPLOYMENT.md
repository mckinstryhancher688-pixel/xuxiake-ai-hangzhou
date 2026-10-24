# 生产部署兼容性说明（第七阶段 · 任务二）

这份文档回答一个问题：**当前架构能不能原样搬到云上跑，代价是什么。**
判据不是「`next build` 能不能成功」，而是「三条真实付费链路（飞猪 CLI / 高德 / 百炼）会不会失效，以及防止重复扣费的护栏还成不生效」。

---

## 2026-10-24 生产发布

当前入口为 [travel.peiqirui.com](http://travel.peiqirui.com/)，采用 ECS 常驻 Docker 应用与 Nginx 反向代理。
本次发布代码为 `c906649`，前后端来自同一份本地生产构建；沿用已有依赖、服务配置与 `xuxiake-data` 持久化卷。
页面、构建身份与快照恢复检查通过，未重跑付费业务闭环。具体证据和回退点见[发布记录](release-2026-10-24.md)。

## 结论先说

**推荐：常驻单进程 Node.js 主机（自己跑 `next build` + `next start`，或用 Docker）。**

理由只有一条：本项目所有「避免重复扣费」的机制都是**进程内状态**——小时级调用上限、结果缓存、整条流水线的 30 分钟缓存、百炼那段对话的 session 表。
Serverless 的多实例 + 冷启动会把这些护栏变成「每个实例各算各的、一重启就归零」，功能表面正常，账单不表面正常。

**Vercel 一类的 serverless：能构建，也能跑通一次完整真实调用链，但不建议直接上线。**
它不是「不兼容」，而是「兼容到会让成本护栏失去意义」。下面第二节是逐条依据。

---

## 一、已经实测过的事实（不是推测）

| 事实 | 依据 | 对部署的含义 |
| --- | --- | --- |
| 飞猪 `@fly-ai/flyai-cli` 只有 npm CLI 形态，没有 HTTP API | 包内只有 `dist/flyai-bundle.cjs`（68,493 字节） | 服务端必须**真的起子进程**，任何「纯 HTTP 的运行时」都跑不了这条链路 |
| 调用方式是 `spawn(process.execPath, [cliEntry, …])` | `src/lib/server/flyai-cli.ts` | 不走 shell、不依赖全局 `PATH`、不依赖 npm 全局安装，只需要一个能执行 JS 文件的 Node |
| CLI 入口靠运行时 `fs.existsSync` 查找：项目 `node_modules` → `FLYAI_CLI_ROOT` → `npm_config_prefix` | `src/lib/server/flyai-cli.ts:62-66` | Next 的文件追踪基于 require graph，**运行时才查找的文件不会被自动带上**，所以 `next.config.ts` 里的 `outputFileTracingIncludes["/api/discover"]` 是硬性条件，删掉就变成功能性失败 |
| CLI 会往 `~/.flyai/` 写 `device-id` 与 `config.json` | 读 bundle 源码：写入路径包在 `try { … } catch { return null }`，config 读取失败降级成 `{}` | 只读文件系统 / 没有可写 HOME **不会**让调用失败；`cwd` 也已经设成 `os.tmpdir()` |
| Windows 上 CLI 打印完 JSON 后会因 libuv 断言以非 0 退出 | 本地真实调用复现 | 判据是「stdout 有没有合法 JSON」，退出码只写进 proof 做参考，不做门控 → 平台差异已经在代码里消化 |
| 子进程环境变量是白名单：`PATH/HOME/USERPROFILE/SystemRoot/TEMP/TMP/COMSPEC/LANG/TZ/NODE_EXTRA_CA_CERTS` + `FLYAI_API_KEY` | `buildChildEnv()` in `src/lib/server/flyai-cli.ts` | 早先是展开整个 `process.env`。云端那里面装着高德与百炼的全部凭据，等于把它们交给一个第三方混淆包——已修 |
| 超时：CLI 60s / 百炼回合 90s / 高德 REST 15s / 高德代理 12s | `flyai-cli.ts:12`、`agent.ts:61-62`、`amap.ts:18`、`amap-js.ts:26` | 单次外部调用最长 90s；一次冷跑要串行打 60+ 次高德，`/api/verify` 的整体耗时随配额与网络浮动，本机观测在十几秒到几十秒之间 |

---

## 二、Vercel 逐条对照（文档版本 2026-08-24）

能过关的部分：

- **Node 子进程**：Node runtime 支持 `child_process`，官方称 full Node.js coverage → spawn 本身没问题。
- **时长**：Hobby 的 `maxDuration` 默认与上限都是 300s → 60s CLI、90s 百炼回合都在范围内。
- **体积**：函数产物 250MB、2GB/1vCPU → CLI 只有 68KB，完全没有压力。
- **请求体**：4.5MB → `/api/agent` 自己只接受 8KB。
- **百炼长连接**：回合是**服务端等完整结果**再返回 JSON，浏览器不挂长连接，90s < 300s → 不会被函数超时切断。

会出问题的部分（这才是结论）：

| 进程内状态 | 位置 | serverless 多实例 / 冷启动后的实际行为 |
| --- | --- | --- |
| 飞猪 12 次/小时上限 + 10 分钟分类缓存 | `discover.ts:19` | 每实例独立计数 → 上限最多变成 12×实例数；冷启动直接归零 |
| 高德 POI 40 次/小时、步行 80 次/小时 | `amap.ts:32-33` | 同上 |
| 高德结果缓存（6 小时） | `amap.ts:30` | 冷启动清空 → 同一条路线被重新逐段实测 |
| 整条核验流水线缓存（30 分钟） | `verify.ts:52` | 冷启动清空。**冷跑实测：勾一个类别 36 次高德请求（11 次 POI + 25 次步行），勾两个类别 62 次（21 + 41）**，一次无谓重放就是几十次调用 |
| 百炼 40 回合/小时 + 超限前的只读预检 | `bailian.ts:117` | 每实例独立计数 → 真金白银的 token 回合按实例数放大 |
| 百炼 session 表（30 分钟 TTL，「少走一点」依赖同一段对话的上文） | `agent.ts:60` | **最硬的一条**：请求落到另一个实例就查不到 session，要么丢上文重新建会话，要么直接失败 |
| 高德安全代理 240 次/分钟 | `amap-js.ts:28` | 每实例 240 → 对上游实际可达 240×N |
| 双人协商方案表（24 条 / 72 小时）与事实集（6 小时） | `plan-store.ts:47-48`、`facts.ts` | 同伴点开链接落到另一台机器 → 如实 410「方案在本实例上找不到」，不会假装协商还在 |
| 最小快照落盘 `.data/plan-snapshot.json` | `plan-snapshot.ts:26-29` | **需要一个可写目录**。只读文件系统上关键状态写不进去，端点会把已成功的内存迁移改报 `persist-failed`（500）而不是假装已保存；临时文件系统（多数 serverless）则每次冷启动回到"没有快照" |

再加一条区域问题：飞猪、高德、百炼都是大陆服务。从海外区域调用，每次请求叠加几百毫秒到数秒；而**一次冷跑核验就是 60+ 次串行高德请求**（见上表），区域不匹配带来的延迟会成倍放大，首屏「开始核验」明显变慢，而且这个抖动正好打在 30 分钟缓存过期后的第一次点击上。

所以「Vercel 能不能上」的诚实回答是：
**演示 5 分钟可以；作为对外公布的长期入口不行**，因为我无法向评委保证「点一次只花一次钱」。

要在 serverless 上保住语义，必须把上表 9 项状态搬到外部存储（Redis 的 `INCR`+`EXPIRE` 做限流、
KV 做 session 表与协商方案/快照），并把服务区域选到大陆就近。那是一次独立的架构改造，
不属于本次「不新增任何产品功能」的范围，所以**本次没有做，也没有假装它没问题**。

---

## 三、推荐部署方式与配置

### 主机
最小规格即可（1 vCPU / 1–2GB）。本机（Windows，内存偏紧）构建实测：默认并行度下静态生成阶段用了 11 个 worker，构建通过。
小内存云主机上如果构建被 OOM 杀掉，要按 Next 自身的开关降并行（`NEXT_WEBPACK_PARALLELISM`，或加 swap），**不要**相信 `NEXT_BUILD_WORKERS` 这种并不存在的变量名。

```bash
npm ci
npx next build
npx next start -p 3000
```

### 一个可写目录（双人协商新增的要求）
`next start` 会把协商快照写到 `<项目>/.data/plan-snapshot.json`（原子写：先写 `${pid}.tmp` 再 `rename`）。
Docker / 云主机上只要那个路径可写就行；要换位置用 `PLAN_SNAPSHOT_FILE` 指过去，**并且把它挂成卷**——
文件随容器一起销毁的话，"重启后同伴的链接还能用"这件事就不成立，但功能仍然安全：读不到就是如实 410。
只读文件系统上也不会静默成功：写不进去时端点返回 `persist-failed`（500）并说明原因，界面对应动作不当成功处理。

### 反向代理要满足两点
1. 读超时 ≥ 120s（百炼回合 90s + 网络余量），并且**不要缓冲响应**。
2. 原样放过 `/_AMapService/…`——高德 JS SDK 硬性要求安全代理的一级路由是 `_AMapService`（写成别的就会在首屏弹一个阻塞提示），本项目由 `next.config.ts` 的 rewrite 把它接到真实 handler `/amap-proxy/…`。反向代理若吃掉下划线路径或改写它，底图打不出来。`next start` 自带这条 rewrite，平台不需要额外配置；只有**完全脱离 Next** 自己起 nginx 时才需要手写 `location /_AMapService/ { proxy_pass http://127.0.0.1:3000/amap-proxy/; }`。

### 环境变量（只列名字，永不写值）

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `FLYAI_API_KEY` | 是 | 飞猪 CLI |
| `AMAP_WEB_KEY` | 是 | 高德「Web 服务」Key，服务端 REST 用 |
| `AMAP_JS_KEY` | 是 | 高德「Web 端 (JS API)」Key，必须是 JS 类型，不能拿 Web 服务 Key 冒充 |
| `AMAP_JS_SECURITY_CODE` | 是 | 高德 JS 安全密钥，只在服务端 `/amap-proxy` handler 里补进请求；浏览器侧看到的是官方一级路由 `/_AMapService` |
| `DASHSCOPE_API_KEY` | 是 | 百炼 `sk-ws-` 工作空间密钥 |
| `BAILIAN_WORKSPACE_ID` / `BAILIAN_AGENT_ID` / `BAILIAN_ENV_ID` | 是 | 百炼三元组 |
| `BAILIAN_REGION` | 否 | 默认 `cn-beijing`，Agent 不在北京区域时才需要设 |
| `FLYAI_CLI_ROOT` | 否 | 只有把 CLI 装在**全局**而不是项目依赖时才需要 |
| `PLAN_SNAPSHOT_FILE` | 否 | 双人协商快照位置，默认 `<项目>/.data/plan-snapshot.json`；该目录必须可写且不进 Git |

全部都不带 `NEXT_PUBLIC_` 前缀 → 不进浏览器包。`.env.example` 是模板，`.env.local` 已被 `.gitignore` 忽略。

### 如果部署环境拿不到 CLI
`/api/discover` 会返回**带解释的失败**（提示检查 `outputFileTracingIncludes` 或设置 `FLYAI_CLI_ROOT`），UI 上明确显示这条链路失败。
**不允许**为了「部署看起来成功」把它换成没有标注的 Mock——这是本次任务的硬约束。

---

## 四、上线后自检（本地和线上用同一套命令）

```bash
BASE=https://你的域名

curl -s $BASE/api/discover | head -c 400   # 看 hourlyCallCap、cliEntry（已脱敏成相对路径）
curl -s $BASE/api/verify                    # 看 placeHourlyUsed / walkingHourlyUsed / cacheEntries / pid
curl -s $BASE/api/agent                     # 只有 keyMask / hostMasked / agentIdMasked，没有明文
curl -s $BASE/api/plan                      # 看 plans / facts / persist（快照相对路径与恢复结果）/ pid
BASE_URL=$BASE node evidence/phase6-accept.mjs   # 25 项真实浏览器验收（可见窗口、真实鼠标）
BASE_URL=$BASE node evidence/plan-guard-probe.mjs # 12 项端点守卫，零外部调用
```

`/api/plan` 的 `persist.restored.status` 是重启后第一个该看的字段：`loaded` 说明快照真的把方案带回来了，
`corrupt` / `schema-mismatch` 说明整份拒绝恢复（不会拿半份状态当有效），`missing` 说明这台机器上没有快照。
`pid` 与它配对看：多实例部署时同一个方案换个实例读，`plans.entries` 会归零、`pid` 会跳变——这正是
「换实例＝方案丢失」的如实暴露，不是 bug。

`/api/verify` 里的 `pid` 是故意留的：多实例部署时它会跳变，配合 `cacheEntries` 从 0 重来，就能一眼看出「每实例各算各的」到底有没有发生。
