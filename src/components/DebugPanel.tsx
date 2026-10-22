import type { AgentController } from "@/hooks/useAgent";
import type { Discover } from "@/hooks/useDiscover";
import type { MapConfigState } from "@/hooks/useMapJsConfig";
import type { VerifiedRoute } from "@/hooks/useVerifiedRoute";
import type { FlyAiServerStatus } from "@/lib/discovery";
import type { AmapServerStatus } from "@/lib/verification";
import type {
  AdjustResponse,
  AgentCallProof,
  AgentServerStatus,
  AgentTurnLatency,
  DiscoverBatch,
  ExploreResponse,
  FlyAiCallProof,
  VerifyReport,
} from "@/lib/types";

/**
 * 技术日志与原始 JSON 一律收在这里，默认折叠，避免挤占用户界面。
 * 这里出现的所有字符串都是服务端已经脱敏过的：只有 key 的形状（96d9****5c），
 * 没有 key 本身，也没有带 key 的完整请求 URL。
 */
export function DebugPanel({
  discover,
  verified,
  agent,
  mapConfig,
  geometryNote,
  demo,
}: {
  discover: Discover;
  verified: VerifiedRoute;
  agent: AgentController;
  mapConfig: MapConfigState;
  geometryNote: string | null;
  /** 核验之后，阶段一那条演示行程就从主界面撤下来，只留在这里。 */
  demo: { label: string; totalMinutes: number; stops: { name: string; stayMinutes: number }[] } | null;
}) {
  const report = verified.report;
  const proofs = (discover.batch?.results ?? [])
    .map((result) => result.proof)
    .filter((proof): proof is FlyAiCallProof => proof !== null);

  return (
    <details className="rounded-2xl border border-line bg-card shadow-sm">
      <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-ink-700">
        开发调试面板 · 技术日志与原始 JSON
        <span className="ml-2 font-normal text-ink-300">
          （默认折叠；这里不含任何密钥，只有脱敏后的形状）
        </span>
      </summary>

      <div className="space-y-3 border-t border-line px-4 py-3">
        <FlyAiStatus status={discover.status} />
        <AmapStatus status={verified.status} />
        <MapJsStatus state={mapConfig} geometryNote={geometryNote} />
        <AgentStatus status={agent.status} />

        {demo && (
          <Block title={`阶段一演示行程（Mock · 不是当前生效路线）· ${demo.label} · ${demo.stops.length} 站 / ${demo.totalMinutes} 分钟`}>
            <ul className="mt-1 space-y-0.5">
              {demo.stops.map((stop) => (
                <li key={stop.name} className="text-[10px] text-ink-500">
                  {stop.name} · 停留 {stop.stayMinutes} 分钟
                </li>
              ))}
            </ul>
          </Block>
        )}

        {proofs.length > 0 && (
          <Block title={`飞猪 CLI 调用凭证 · ${proofs.length} 次`}>
            {proofs.map((proof, index) => (
              <ProofLine key={`${proof.invokedAt}-${index}`} proof={proof} />
            ))}
          </Block>
        )}

        {report && (
          <Block
            title={`高德调用日志 · ${report.amap.log.length} 条（POI ${report.amap.placeCalls} 次 + 步行 ${report.amap.walkingCalls} 次真实请求，缓存命中 ${report.amap.cacheHits} 次，失败 ${report.amap.failedCalls} 次）`}
          >
            <ul className="space-y-1">
              {report.amap.log.map((entry, index) => (
                <li key={index} className="font-mono text-[9px] leading-relaxed text-ink-500">
                  <span className="text-ink-300">#{String(index + 1).padStart(2, "0")}</span>{" "}
                  {entry.api} · http={entry.httpStatus ?? "-"} · infocode={entry.infocode ?? "-"} ·{" "}
                  {entry.durationMs}ms{entry.retries ? ` · 限流重试${entry.retries}次` : ""}
                  {entry.fromCache ? " · 缓存命中" : ""}
                  {entry.error ? ` · 错误：${entry.error}` : ""}
                  <span className="block break-all text-ink-300">{entry.params}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {agent.arrival?.proof && <TurnProof title="「我到了」" proof={agent.arrival.proof} />}
        {agent.adjustment?.proof && (
          <TurnProof title="「少走一点」" proof={agent.adjustment.proof} />
        )}

        {discover.batch && <RawJson title="原始 JSON · 飞猪 DiscoverBatch" value={discover.batch} />}
        {/* 「少走一点」之后主界面只显示当前生效的那一条；调整前的原始核验记录留在这里 */}
        {report && (
          <RawJson
            title={`原始 JSON · 高德核验记录（调整前的原路线 · ${report.itinerary?.stops.length ?? 0} 站）`}
            value={report}
          />
        )}
        {agent.arrival && (
          <RawJson title="原始 JSON · 百炼「我到了」响应" value={agent.arrival} />
        )}
        {agent.adjustment && (
          <RawJson title="原始 JSON · 百炼「少走一点」响应" value={agent.adjustment} />
        )}
      </div>
    </details>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-paper p-2.5 ring-1 ring-line">
      <p className="text-[10px] font-semibold text-ink-700">{title}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/**
 * 百炼回合凭证从生产界面挪到这里：回合确实发生过，但 id、token 用量和延迟拆解
 * 属于开发者核对用的细节，不该出现在用户读的那一屏。
 */
function TurnProof({ title, proof }: { title: string; proof: AgentCallProof }) {
  const tools =
    proof.toolEvents.length === 0
      ? "本回合智能体没有调用任何工具"
      : `本回合工具调用 ${proof.toolEvents.length} 次：${proof.toolEvents.map((event) => event.name).join("、")}`;
  return (
    <Block title={`百炼回合凭证 · ${title}（${proof.eventCount} 个事件）`}>
      <p className="break-all font-mono text-[9px] leading-relaxed text-ink-500">
        {formatTime(proof.invokedAt)} · {Math.round(proof.durationMs / 1000)}s · API {proof.apiCalls} 次 ·
        问智能体 {proof.modelTurns} 轮 · token 输入 {proof.usage.inputTokens} / 输出{" "}
        {proof.usage.outputTokens} / 缓存命中 {proof.usage.cacheReadTokens} · 结束 {proof.howItEnded}
        {proof.stopReason ? `（${proof.stopReason}）` : ""} · Agent {proof.agentIdMasked} · Session{" "}
        {proof.sessionIdMasked} · {tools} ·{" "}
        {proof.flyaiToolCalled ? "飞猪工具：有调用" : "飞猪工具：本回合未调用（数据由服务端供给）"}
      </p>
      {proof.sessionOverrides.length > 0 && (
        <p className="mt-1 break-all font-mono text-[9px] leading-relaxed text-ink-300">
          会话覆盖（实测生效）：{proof.sessionOverrides.join("，")}
          {proof.resolvedModels.length > 0
            ? ` · AUTO 实际使用的模型：${proof.resolvedModels.join("、")}`
            : " · 本回合没有收到模型回执"}
        </p>
      )}
      {proof.latencyPerTurn.map((latency, index) => (
        <LatencyLine
          key={`${latency.totalMs}-${index}`}
          latency={latency}
          turn={index + 1}
          of={proof.latencyPerTurn.length}
        />
      ))}
      <ul className="mt-1 space-y-0.5">
        {proof.toolEvents.map((event, index) => (
          <li key={index} className="font-mono text-[9px] leading-relaxed text-ink-500">
            #{index + 1} {event.name} · call={event.callIdMasked ?? "—"} · error={event.isError ? "是" : "否"}
            {event.argumentsPreview && (
              <span className="block break-all text-ink-300">args {event.argumentsPreview}</span>
            )}
            {event.outputPreview && (
              <span className="block break-all text-ink-300">out {event.outputPreview}</span>
            )}
          </li>
        ))}
        {proof.toolEvents.length === 0 && (
          <li className="font-mono text-[9px] leading-relaxed text-ink-300">
            本回合没有任何 tool_call 事件：智能体只做了文本生成，飞猪与高德的数据都是服务端供给的。
          </li>
        )}
      </ul>
    </Block>
  );
}

/** 延迟归因：把「等建连 / 排队 / 生成」拆开，才能看出瓶颈到底在哪一段。 */
function LatencyLine({
  latency,
  turn,
  of,
}: {
  latency: AgentTurnLatency;
  turn: number;
  of: number;
}) {
  const show = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  return (
    <p className="mt-1 break-all font-mono text-[9px] leading-relaxed text-ink-300">
      延迟拆解{of > 1 ? `（第 ${turn} 轮）` : ""}：建连 {show(latency.streamConnectedMs)} → 首事件{" "}
      {show(latency.firstEventMs)} → 开始出字 {show(latency.firstDeltaMs)} → 答案首字{" "}
      {show(latency.firstAnswerDeltaMs)} → 生成耗时 {show(latency.generationMs)}，总计{" "}
      {show(latency.totalMs)}。HTTP {latency.httpAttempts} 次 / 网络重试 {latency.httpRetries} 次。
      提示 {latency.promptChars} 字 · 思考 {latency.reasoningChars} 字 · 答案 {latency.answerChars} 字。
      分流：{latency.streamKinds}。
    </p>
  );
}

function FlyAiStatus({ status }: { status: FlyAiServerStatus | null }) {
  if (!status) {
    return (
      <Block title="飞猪服务端状态">
        <p className="text-[10px] text-ink-300">还没取到（GET /api/discover 未返回）。</p>
      </Block>
    );
  }
  const cacheDetail = status.cacheEntries.length
    ? status.cacheEntries
        .map((entry) => `${entry.key} ${entry.ageSeconds}s/${entry.itemCount}条`)
        .join("，")
    : "空";
  return (
    <Block title="飞猪服务端状态 · GET /api/discover">
      <p className="break-all font-mono text-[10px] leading-relaxed text-ink-500">
        pid={status.pid} · FLYAI_API_KEY{" "}
        {status.keyPresent ? `已配置（${status.keyMask}）` : "未配置"} · CLI{" "}
        {status.cliAvailable ? status.cliEntry : "未找到"} · 缓存 {cacheDetail} · 本小时真实调用{" "}
        {status.hourlyCallsUsed}/{status.hourlyCallCap} · 服务端时间{" "}
        {formatTime(status.serverTime)}
      </p>
    </Block>
  );
}

function AmapStatus({ status }: { status: AmapServerStatus | null }) {
  if (!status) {
    return (
      <Block title="高德服务端状态">
        <p className="text-[10px] text-ink-300">还没取到（GET /api/verify 未返回）。</p>
      </Block>
    );
  }
  return (
    <Block title="高德服务端状态 · GET /api/verify">
      <p className="break-all font-mono text-[10px] leading-relaxed text-ink-500">
        pid={status.pid} · AMAP_WEB_KEY {status.keyPresent ? `已配置（${status.keyMask}）` : "未配置"} ·
        本小时 POI 搜索 {status.placeHourlyUsed}/{status.placeHourlyCap} · 步行路径{" "}
        {status.walkingHourlyUsed}/{status.walkingHourlyCap} · 单条缓存 {status.cacheTtlSeconds}s ·
        缓存条目 {status.cacheEntries} · 流水线缓存 {status.pipelineCacheTtlSeconds}s · 预算{" "}
        {status.budgetMinutes} 分钟（停留 {status.simulatedStayMinutes} + 缓冲 {status.bufferMinutes}
        ） · 偏差阈值 {status.deviationSuspectMeters} 米 · 请求没带 categories 时的默认类别{" "}
        {status.categories.join("/")} ·
        起点关键词 {status.startKeyword} · 服务端时间 {formatTime(status.serverTime)}
      </p>
    </Block>
  );
}

function MapJsStatus({
  state,
  geometryNote,
}: {
  state: MapConfigState;
  geometryNote: string | null;
}) {
  const config = state.config;
  return (
    <Block title="真实地图（高德 JS API 2.0）· GET /api/map-config">
      <p className="break-all font-mono text-[10px] leading-relaxed text-ink-500">
        配置状态 {state.phase} · AMAP_JS_KEY{" "}
        {config?.jsKeyMask ? `已配置（${config.jsKeyMask}）` : "未配置"} · 安全密钥{" "}
        {config ? (config.securityCodePresent ? "已在服务端" : "未配置") : "未知"} · 代理{" "}
        {config?.securityHost ?? "/_AMapService"}（jscode 只在服务端补，浏览器拿不到）
      </p>
      {config && config.missing.length > 0 && (
        <p className="mt-1 text-[10px] leading-relaxed text-accent-600">
          缺少：{config.missing.join("、")}。补齐后才会加载真实底图，在此之前保持演示模式。
        </p>
      )}
      {state.reason && (
        <p className="mt-1 text-[10px] leading-relaxed text-ink-300">{state.reason}</p>
      )}
      {geometryNote && (
        <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-ink-500">
          步行折线（POST /api/route-geometry）· {geometryNote}
        </p>
      )}
    </Block>
  );
}

function AgentStatus({ status }: { status: AgentServerStatus | null }) {
  if (!status) {
    return (
      <Block title="百炼服务端状态">
        <p className="text-[10px] text-ink-300">还没取到（GET /api/agent 未返回）。</p>
      </Block>
    );
  }
  return (
    <Block title={`百炼服务端状态 · GET /api/agent（调用日志 ${status.log.length} 条）`}>
      <p className="break-all font-mono text-[10px] leading-relaxed text-ink-500">
        pid={status.pid} · DASHSCOPE_API_KEY{" "}
        {status.keyPresent ? `已配置（${status.keyMask}）` : `未配置，缺 ${status.missingVars.join("/")}`} ·
        域名 {status.hostMasked} · Agent {status.agentIdMasked} · Env{" "}
        {status.environmentIdMasked} · 活动会话 {status.activeSessions}（TTL {status.sessionTtlSeconds}s）·
        回合超时 {status.turnTimeoutSeconds}s · 付费回合 {status.totalTurns} 个（本小时{" "}
        {status.turnsLastHour}/{status.turnHourlyCap}，达上限后服务端直接拒绝、不再发起调用）· 向百炼发出的
        HTTP 请求合计 {status.totalApiCalls} 次（含会话建立等不计 token 的请求，其中读取 Agent 配置{" "}
        {status.statusReads} 次）· token 输入 {status.usage.inputTokens} / 输出{" "}
        {status.usage.outputTokens} / 缓存命中读 {status.usage.cacheReadTokens} · 服务端时间{" "}
        {formatTime(status.serverTime)}
      </p>
      <p className="mt-1 break-all font-mono text-[9px] leading-relaxed text-ink-300">
        控制台里的真实 Agent：
        {status.profile
          ? ` ${status.profile.name ?? "—"} v${status.profile.version ?? "—"} · model=${status.profile.modelId ?? "—"} · 思考=${status.profile.enableThinking === null ? "未知" : status.profile.enableThinking ? `开(预算 ${status.profile.thinkingBudget ?? "?"} token)` : "关"} · max_tokens=${status.profile.maxTokens ?? "不限"} · skills=${status.profile.skillCount} · mcp=${status.profile.mcpServerCount} · 已启用工具 ${status.profile.enabledTools.join("/") || "无"}`
          : ` 读取失败（${status.profileError ?? "无错误信息"}）`}
      </p>
      <ul className="mt-1 space-y-0.5">
        {status.log.map((entry, index) => (
          <li key={index} className="font-mono text-[9px] leading-relaxed text-ink-300">
            #{String(index + 1).padStart(2, "0")} {entry.method} {entry.path} ·{" "}
            {entry.httpStatus ?? "-"} · {entry.durationMs}ms{entry.error ? ` · ${entry.error}` : ""}
          </li>
        ))}
      </ul>
    </Block>
  );
}

function ProofLine({ proof }: { proof: FlyAiCallProof }) {
  return (
    <div className="mb-1.5 rounded bg-white/70 px-2 py-1.5 ring-1 ring-line last:mb-0">
      <p className="break-all font-mono text-[9px] leading-relaxed text-ink-500">
        {proof.cacheHit ? "缓存命中 · 未产生新调用" : "真实调用"} · {formatTime(proof.invokedAt)} ·{" "}
        {proof.durationMs}ms · exit={formatExitCode(proof.exitCode)} · stdout {proof.stdoutBytes}B ·
        原始 {proof.rawItemCount} 条
      </p>
      <p className="mt-0.5 break-all font-mono text-[9px] leading-relaxed text-ink-300">
        {proof.command}
      </p>
      <p className="mt-0.5 break-all font-mono text-[9px] leading-relaxed text-ink-300">
        key 来源 {proof.keySource} · CLI {proof.cliEntry}
      </p>
      {proof.exitCode !== 0 && (
        <p className="mt-0.5 text-[9px] leading-relaxed text-ink-300">
          flyai CLI 在 Windows 上打印完结果后会因 libuv 断言崩溃退出，所以退出码非 0；
          成功判据是 stdout 的 JSON 里 status=0。
        </p>
      )}
    </div>
  );
}

function RawJson({
  title,
  value,
}: {
  title: string;
  value: DiscoverBatch | VerifyReport | ExploreResponse | AdjustResponse;
}) {
  return (
    <details className="rounded-lg bg-paper ring-1 ring-line">
      <summary className="cursor-pointer px-2.5 py-2 text-[10px] font-semibold text-ink-700">
        {title}
      </summary>
      <pre className="max-h-72 overflow-auto px-2.5 pb-2.5 font-mono text-[9px] leading-relaxed text-ink-500">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function formatExitCode(code: number | null): string {
  if (code === null) return "null";
  if (code === 0) return "0";
  return `${code}(0x${(code >>> 0).toString(16).toUpperCase()})`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { hour12: false });
}
