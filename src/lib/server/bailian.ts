import type {
  AgentCallLogEntry,
  AgentProfile,
  AgentToolEvent,
  AgentTurnLatency,
  TokenUsage,
} from "@/lib/types";

if (typeof window !== "undefined") {
  throw new Error("lib/server/bailian 只能在 Next.js 服务端加载。");
}

/** 官方 Managed Agents API 的区域；文档目前只给了 cn-beijing。 */
const DEFAULT_REGION = "cn-beijing";
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * 实测：SSE 订阅要早于消息提交，否则增量事件全部错过（不回放历史）。
 * 探针留 1.2s 稳定拿到 119 个事件；现在改成「建连即提交」，这个值只作为兜底上限。
 */
const STREAM_READY_MS = 1_200;
const TURN_TIMEOUT_MS = 120_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface BailianConfig {
  key: string;
  workspace: string;
  agentId: string;
  environmentId: string;
  region: string;
  /** 未脱敏，只在服务端内部拼 URL 用，任何日志/响应都不返回它 */
  baseUrl: string;
}

export const BAILIAN_VAR_NAMES = [
  "DASHSCOPE_API_KEY",
  "BAILIAN_WORKSPACE_ID",
  "BAILIAN_AGENT_ID",
  "BAILIAN_ENV_ID",
] as const;

export function missingBailianVars(): string[] {
  return BAILIAN_VAR_NAMES.filter((name) => !process.env[name]?.trim());
}

export function readBailianConfig(): BailianConfig | null {
  if (missingBailianVars().length > 0) return null;
  const key = process.env.DASHSCOPE_API_KEY!.trim();
  const workspace = process.env.BAILIAN_WORKSPACE_ID!.trim();
  const agentId = process.env.BAILIAN_AGENT_ID!.trim();
  const environmentId = process.env.BAILIAN_ENV_ID!.trim();
  const region = process.env.BAILIAN_REGION?.trim() || DEFAULT_REGION;
  return {
    key,
    workspace,
    agentId,
    environmentId,
    region,
    baseUrl: `https://${workspace}.${region}.maas.aliyuncs.com/api/v1/agentstudio`,
  };
}

export function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-2)}`;
}

export function maskId(id: string | null | undefined): string {
  if (typeof id !== "string" || id.length < 8) return id ?? "—";
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/**
 * 百炼的 GET /sessions/{id} 会把注入的环境变量原样吐回来，
 * 所以任何出这个模块的字符串都要先过一遍脱敏。
 */
function makeScrubber(config: BailianConfig): (text: unknown) => string {
  const secrets: [string, string][] = [
    [config.key, maskKey(config.key) ?? "****"],
    [config.workspace, maskId(config.workspace)],
    [config.agentId, maskId(config.agentId)],
    [config.environmentId, maskId(config.environmentId)],
  ];
  return (text: unknown) => {
    let out = typeof text === "string" ? text : String(text ?? "");
    for (const [secret, replacement] of secrets) {
      if (secret) out = out.split(secret).join(replacement);
    }
    // 会话 ID 是动态生成的，不在 config 里，但 GET /sessions/{id} 会带回明文环境变量，
    // 所以它和任何 ID 一样不能原样离开这个模块。
    return out.replace(/\b(?:sesn|agent|env)_[A-Za-z0-9]{8,}\b/g, (id) => maskId(id));
  };
}

const emptyUsage = (): TokenUsage => ({
  modelRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
});

/* ── 服务端调用计数：/api/agent 的 GET 会把它原样展示到调试面板 ─────── */

let apiCalls = 0;
/** 读取 Agent 配置那种 GET 不产生 token 费用，单独计数，避免混进「调用次数」里误导人。 */
let statusReads = 0;
let turns = 0;
const usageTotal = emptyUsage();
const log: AgentCallLogEntry[] = [];
const LOG_LIMIT = 40;

/**
 * 公开部署后任何人都能点「我到了」，每一回合都是真金白银的 token 费用。
 * 飞猪、高德侧早有小时上限，百炼侧此前没有 —— 补在这里，超限直接拒绝，而不是继续扣费。
 */
const TURN_HOURLY_CAP = 40;
const TURN_CAP_MESSAGE = `本小时智能体回合已达上限（${TURN_HOURLY_CAP} 回合），已拒绝发起新的付费调用，请一小时后再试。`;
const turnStamps: number[] = [];

function acquireTurnSlot(): string | null {
  const now = Date.now();
  while (turnStamps.length && turnStamps[0] < now - 3_600_000) turnStamps.shift();
  if (turnStamps.length >= TURN_HOURLY_CAP) return TURN_CAP_MESSAGE;
  turnStamps.push(now);
  return null;
}

function turnsLastHour(): number {
  const now = Date.now();
  while (turnStamps.length && turnStamps[0] < now - 3_600_000) turnStamps.shift();
  return turnStamps.length;
}

/**
 * 只读预检，不占用额度。放在真正花钱的流程最前面：否则超限请求也会一路走到
 * 「建百炼会话」那一步，等于用注定失败的请求刷会话配额。
 */
export function turnCapMessage(): string | null {
  return turnsLastHour() >= TURN_HOURLY_CAP ? TURN_CAP_MESSAGE : null;
}

function pushLog(entry: AgentCallLogEntry): void {
  log.push(entry);
  if (log.length > LOG_LIMIT) log.shift();
}

export interface BailianCounters {
  totalApiCalls: number;
  totalTurns: number;
  statusReads: number;
  turnsLastHour: number;
  turnHourlyCap: number;
  usage: TokenUsage;
  log: AgentCallLogEntry[];
}

export function bailianCounters(): BailianCounters {
  return {
    totalApiCalls: apiCalls,
    totalTurns: turns,
    statusReads,
    turnsLastHour: turnsLastHour(),
    turnHourlyCap: TURN_HOURLY_CAP,
    usage: { ...usageTotal },
    log: log.map((entry) => ({ ...entry })),
  };
}

function addUsage(usage: TokenUsage): void {
  usageTotal.modelRequests += usage.modelRequests;
  usageTotal.inputTokens += usage.inputTokens;
  usageTotal.outputTokens += usage.outputTokens;
  usageTotal.cacheReadTokens += usage.cacheReadTokens;
}

/* ── 普通 JSON 请求 ─────────────────────────────────────────────── */

interface JsonCall {
  ok: boolean;
  status: number;
  parsed: Record<string, unknown> | null;
  error: string | null;
  durationMs: number;
}

async function callJson(
  config: BailianConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<JsonCall> {
  const started = Date.now();
  apiCalls += 1;
  const scrub = makeScrubber(config);
  const entry: AgentCallLogEntry = {
    at: new Date().toISOString(),
    method,
    path: scrub(path),
    httpStatus: null,
    durationMs: 0,
    error: null,
  };

  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.key}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${config.baseUrl}${path}`, init);
    const text = await response.text();
    entry.httpStatus = response.status;
    entry.durationMs = Date.now() - started;

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      entry.error = scrub(`响应不是 JSON：${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      // 错误体形状分两层：网关是扁平 code，业务层是 error.code
      const code = (parsed?.code as string) ?? undefined;
      const nested = (parsed?.error as Record<string, unknown> | undefined)?.code as
        | string
        | undefined;
      entry.error = `${response.status} ${scrub([code, nested].filter(Boolean).join("/") || "")}`.trim();
    }
    pushLog(entry);
    return {
      ok: response.ok,
      status: response.status,
      parsed,
      error: entry.error,
      durationMs: entry.durationMs,
    };
  } catch (caught) {
    entry.durationMs = Date.now() - started;
    entry.error = scrub(caught instanceof Error ? caught.message : String(caught));
    pushLog(entry);
    return { ok: false, status: 0, parsed: null, error: entry.error, durationMs: entry.durationMs };
  }
}

/* ── Agent 配置读取：确认调用的是控制台里那个托管智能体 ─────────────── */

export async function fetchAgentProfile(
  config: BailianConfig,
): Promise<{ ok: boolean; error: string | null; profile: AgentProfile | null }> {
  statusReads += 1;
  const call = await callJson(config, "GET", `/agents/${encodeURIComponent(config.agentId)}`);
  if (!call.ok || !call.parsed) {
    return { ok: false, error: call.error ?? "读取 Agent 配置失败。", profile: null };
  }
  const parsed = call.parsed;
  const tools = Array.isArray(parsed.tools) ? (parsed.tools as Record<string, unknown>[]) : [];
  const configs = tools.flatMap((tool) =>
    Array.isArray(tool.configs) ? (tool.configs as Record<string, unknown>[]) : [],
  );
  const model = parsed.model as Record<string, unknown> | undefined;
  return {
    ok: true,
    error: null,
    profile: {
      name: typeof parsed.name === "string" ? parsed.name : null,
      version: typeof parsed.version === "number" ? parsed.version : null,
      modelId: typeof model?.id === "string" ? model.id : null,
      enableThinking: typeof model?.enable_thinking === "boolean" ? model.enable_thinking : null,
      thinkingBudget: typeof model?.thinking_budget === "number" ? model.thinking_budget : null,
      maxTokens: typeof model?.max_tokens === "number" ? model.max_tokens : null,
      enabledTools: configs
        .filter((item) => item.enabled === true)
        .map((item) => String(item.name ?? "?")),
      skillCount: Array.isArray(parsed.skills) ? parsed.skills.length : 0,
      mcpServerCount: Array.isArray(parsed.mcp_servers) ? parsed.mcp_servers.length : 0,
    },
  };
}

/* ── 会话 ───────────────────────────────────────────────────────── */

export interface SessionOverrides {
  /** 常驻规则放进会话级 system，就不会在每一条用户消息里重复付费 */
  system: string;
  /** 内置工具的 schema 会进每次模型请求的前缀；本产品的智能体不需要它们 */
  disableTools: boolean;
}

export async function createSession(
  config: BailianConfig,
  title: string,
  overrides: SessionOverrides,
): Promise<{
  ok: boolean;
  error: string | null;
  sessionId: string | null;
  appliedOverrides: string[];
}> {
  const agent: Record<string, unknown> = {
    type: "agent_with_overrides",
    id: config.agentId,
  };
  const appliedOverrides: string[] = [];
  if (overrides.disableTools) {
    agent.tools = [];
    appliedOverrides.push("tools=[]");
  }
  if (overrides.system) {
    agent.system = overrides.system;
    appliedOverrides.push(`system=${overrides.system.length}字`);
  }

  const call = await callJson(config, "POST", "/sessions", {
    agent,
    environment_id: config.environmentId,
    title,
  });
  const sessionId = call.parsed?.id;
  if (!call.ok || typeof sessionId !== "string") {
    return {
      ok: false,
      error: call.error ?? `创建会话失败（HTTP ${call.status}）。`,
      sessionId: null,
      appliedOverrides: [],
    };
  }
  return { ok: true, error: null, sessionId, appliedOverrides };
}

/* ── SSE 帧解析 ─────────────────────────────────────────────────── */

type FrameHandler = (frame: Record<string, unknown>) => void;

/** 空行分帧、多行 data: 合并、忽略 : 开头的 keepalive —— 实测服务端三种都发。 */
function makeSseParser(onFrame: FrameHandler): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    for (;;) {
      const separator = buffer.indexOf("\n\n");
      if (separator === -1) return;
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^\s/, ""));
      }
      if (dataLines.length === 0) continue;
      try {
        onFrame(JSON.parse(dataLines.join("\n")) as Record<string, unknown>);
      } catch {
        // keepalive 与半截帧都会走到这里，实测不影响最终结果，直接跳过
      }
    }
  };
}

/* ── 回合：先订阅再提交，收完整事件后返回 ──────────────────────────── */

export interface TurnResult {
  ok: boolean;
  error: string | null;
  /** 这一轮开始发起的时间，用来在多轮累加后仍知道整个调用是什么时候发生的 */
  invokedAt: string;
  replyText: string;
  eventCount: number;
  apiCalls: number;
  durationMs: number;
  howItEnded: string;
  stopReason: string | null;
  usage: TokenUsage;
  toolEvents: AgentToolEvent[];
  latency: AgentTurnLatency;
  /** AUTO 实际落到了哪个千问模型；由 model_request_end 事件回报，不是我们自己猜的 */
  resolvedModel: string | null;
}

function preview(text: unknown, limit = 240): string | null {
  if (text === null || text === undefined) return null;
  const value = typeof text === "string" ? text : JSON.stringify(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** content 里 type:"data" 的那一项才是事件正文，实测所有工具/状态/用量事件都这样包。 */
function dataOf(event: Record<string, unknown>): Record<string, unknown> | null {
  const content = event.content;
  if (!Array.isArray(content)) return null;
  for (const item of content as Record<string, unknown>[]) {
    if (item?.type === "data" && item.data) return item.data as Record<string, unknown>;
  }
  return null;
}

function textOf(event: Record<string, unknown>): string {
  const content = event.content;
  if (!Array.isArray(content)) return "";
  return (content as Record<string, unknown>[])
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text ?? ""))
    .join("");
}

/**
 * event_start 帧里携带的「即将开始的那条流」的形状官方文档没写死，
 * 所以这里不猜字段位置：在帧里找 id + type 同时命中 message/reasoning 的那个对象。
 * 找不到就退回「无法分类」，宁可承认观测不到，也不把思考内容当答案推给网页。
 */
function findStreamStart(value: unknown, depth = 0): { id: string; type: string } | null {
  if (depth > 4 || !value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id === "string" &&
    typeof record.type === "string" &&
    (record.type === "message" || record.type === "reasoning")
  ) {
    return { id: record.id, type: record.type };
  }
  for (const child of Object.values(record)) {
    const hit = findStreamStart(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export async function runTurn(
  config: BailianConfig,
  sessionId: string,
  message: string,
  options: { timeoutMs?: number; onDelta?: (text: string) => void } = {},
): Promise<TurnResult> {
  // 付费上限挡在任何请求发出之前：被拒绝的回合不产生 token，也不该被计入用量。
  const rejected = acquireTurnSlot();
  if (rejected) {
    return {
      ok: false,
      error: rejected,
      invokedAt: new Date().toISOString(),
      replyText: "",
      eventCount: 0,
      apiCalls: 0,
      durationMs: 0,
      howItEnded: "rate-limited",
      stopReason: null,
      usage: emptyUsage(),
      toolEvents: [],
      latency: {
        streamConnectedMs: null,
        firstEventMs: null,
        firstDeltaMs: null,
        firstAnswerDeltaMs: null,
        postedMs: 0,
        queueMs: null,
        generationMs: null,
        totalMs: 0,
        httpAttempts: 0,
        httpRetries: 0,
        streamKinds: "未发起（本小时智能体回合已达上限）",
        promptChars: message.length,
        reasoningChars: 0,
        answerChars: 0,
      },
      resolvedModel: null,
    };
  }
  const started = Date.now();
  const invokedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? TURN_TIMEOUT_MS;
  const apiCallsBefore = apiCalls;
  const scrub = makeScrubber(config);
  const usage = emptyUsage();
  const toolEvents: AgentToolEvent[] = [];
  const callIndexByCallId = new Map<string, number>();
  /** key = `${event_id}|${blockIndex}`；一次回复可能同时有 message 与 reasoning 两条流 */
  const deltaBuffers = new Map<string, string[]>();
  /** event_id → 流类型（message / reasoning），从 event_start 帧里尽力识别 */
  const kindByEventId = new Map<string, string>();
  let eventCount = 0;
  let lastCompleteText = "";
  let lastStopReason: string | null = null;
  let streamError: string | null = null;

  let streamConnectedMs: number | null = null;
  let firstEventMs: number | null = null;
  let firstDeltaMs: number | null = null;
  let firstAnswerDeltaMs: number | null = null;
  let postedMs = 0;
  let resolvedModel: string | null = null;
  let classifiedDeltas = 0;
  let unclassifiedDeltas = 0;
  /** 按流类型统计增量字符，用来把「思考」和「答案」的耗时分开 */
  const deltaChars = { message: 0, reasoning: 0, unknown: 0 };
  const elapsed = () => Date.now() - started;

  const controller = new AbortController();
  let resolveDone: (how: string) => void = () => {};
  const done = new Promise<string>((resolve) => {
    resolveDone = resolve;
  });
  /** 订阅建连就立刻提交消息，不再盲目等 1.2 秒 */
  let resolveConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });

  const onFrame = (event: Record<string, unknown>) => {
    eventCount += 1;
    if (firstEventMs === null) firstEventMs = elapsed();
    const type = typeof event.type === "string" ? event.type : null;

    if (event.error) {
      streamError = scrub(JSON.stringify(event.error));
      resolveDone("error");
      return;
    }

    if (type === "event_start") {
      const stream = findStreamStart(event);
      if (stream) kindByEventId.set(stream.id, stream.type);
      return;
    }

    if (type === "event_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      const content = delta?.content as Record<string, unknown> | undefined;
      if (content?.type === "text") {
        const eventId = String(event.event_id ?? "");
        const key = `${eventId}|${String(delta?.index ?? 0)}`;
        const text = String(content.text ?? "");
        const bucket = deltaBuffers.get(key) ?? [];
        bucket.push(text);
        deltaBuffers.set(key, bucket);
        if (firstDeltaMs === null) firstDeltaMs = elapsed();
        const kind = kindByEventId.get(eventId) ?? null;
        if (kind === "message") {
          classifiedDeltas += 1;
          deltaChars.message += text.length;
          if (firstAnswerDeltaMs === null) firstAnswerDeltaMs = elapsed();
          options.onDelta?.(text);
        } else if (kind === "reasoning") {
          classifiedDeltas += 1;
          deltaChars.reasoning += text.length;
        } else {
          unclassifiedDeltas += 1;
          deltaChars.unknown += text.length;
        }
      }
      return;
    }

    if (type === "message" && event.role === "assistant") {
      const text = textOf(event);
      if (text) lastCompleteText = text;
      return;
    }

    if (type === "tool_call" || type === "tool_call_output") {
      const data = dataOf(event) ?? {};
      const callId = typeof data.call_id === "string" ? data.call_id : null;
      if (type === "tool_call") {
        toolEvents.push({
          name: String(data.name ?? "?"),
          callIdMasked: callId ? maskId(callId) : null,
          isError: event.is_error === true,
          argumentsPreview: preview(data.arguments),
          outputPreview: null,
        });
        if (callId) callIndexByCallId.set(callId, toolEvents.length - 1);
      } else {
        const index = callId ? callIndexByCallId.get(callId) : undefined;
        const target = index === undefined ? toolEvents.at(-1) : toolEvents[index];
        if (target) target.outputPreview = preview(data.output);
      }
      return;
    }

    if (type === "model_request_end") {
      const data = dataOf(event) ?? {};
      usage.modelRequests += 1;
      usage.inputTokens += Number(data.input_tokens ?? 0) || 0;
      usage.outputTokens += Number(data.output_tokens ?? 0) || 0;
      usage.cacheReadTokens += Number(data.cache_read_input_tokens ?? 0) || 0;
      const inner = data.model as Record<string, unknown> | undefined;
      const name =
        typeof data.model === "string"
          ? data.model
          : typeof inner?.id === "string"
            ? inner.id
            : null;
      if (name) resolvedModel = name;
      return;
    }

    if (type === "session_status") {
      const data = dataOf(event) ?? {};
      const status = String(data.session_status ?? "");
      if (["idle", "terminated", "error"].includes(status)) {
        const stopReason = data.stop_reason as Record<string, unknown> | undefined;
        if (stopReason?.type) lastStopReason = String(stopReason.type);
        if (status === "idle") resolveDone("status");
        else resolveDone(status);
      }
      return;
    }
  };

  const makeLatency = (): AgentTurnLatency => {
    const totalMs = elapsed();
    return {
      streamConnectedMs,
      firstEventMs,
      firstDeltaMs,
      firstAnswerDeltaMs,
      postedMs,
      queueMs: postedMs > 0 && firstDeltaMs !== null ? firstDeltaMs - postedMs : null,
      generationMs: firstDeltaMs !== null ? totalMs - firstDeltaMs : null,
      totalMs,
      httpAttempts: apiCalls - apiCallsBefore,
      httpRetries: 0,
      streamKinds: `message=${deltaChars.message}字/reasoning=${deltaChars.reasoning}字/unknown=${deltaChars.unknown}字（分类 ${classifiedDeltas} 个、无法分类 ${unclassifiedDeltas} 个）`,
      promptChars: message.length,
      reasoningChars: deltaChars.reasoning + deltaChars.unknown,
      answerChars: deltaChars.message || lastCompleteText.length,
    };
  };

  // 顺序不能反：SSE 不回放历史事件，先订阅才能拿到本次回合的全部增量。
  const streamTask = fetch(
    `${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events/stream` +
      "?event_deltas%5B%5D=message&event_deltas%5B%5D=reasoning",
    {
      headers: { Authorization: `Bearer ${config.key}`, Accept: "text/event-stream" },
      signal: controller.signal,
    },
  )
    .then(async (response) => {
      streamConnectedMs = elapsed();
      resolveConnected();
      apiCalls += 1;
      pushLog({
        at: new Date().toISOString(),
        method: "GET",
        path: scrub(`/sessions/${sessionId}/events/stream`),
        httpStatus: response.status,
        durationMs: Date.now() - started,
        error: response.ok ? null : "SSE 订阅失败",
      });
      if (!response.ok) {
        streamError = scrub((await response.text()).slice(0, 300));
        resolveDone("stream-failed");
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) {
        streamError = "服务端没有返回可读的事件流。";
        resolveDone("stream-empty");
        return;
      }
      const decoder = new TextDecoder();
      const push = makeSseParser(onFrame);
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        push(decoder.decode(chunk.value, { stream: true }));
      }
      resolveDone("stream-end");
    })
    .catch((caught: unknown) => {
      resolveConnected();
      if (controller.signal.aborted) return;
      streamError = scrub(caught instanceof Error ? caught.message : String(caught));
      resolveDone("stream-error");
    });

  await Promise.race([connected, sleep(STREAM_READY_MS)]);

  const posted = await callJson(config, "POST", `/sessions/${sessionId}/events`, {
    input: [{ role: "user", type: "message", content: [{ type: "text", text: message }]}],
  });
  postedMs = elapsed();
  if (!posted.ok) {
    controller.abort();
    await streamTask.catch(() => {});
    return {
      ok: false,
      error: posted.error ?? `提交消息失败（HTTP ${posted.status}）。`,
      invokedAt,
      replyText: "",
      eventCount,
      apiCalls: apiCalls - apiCallsBefore,
      durationMs: Date.now() - started,
      howItEnded: "post-failed",
      stopReason: null,
      usage,
      toolEvents,
      latency: makeLatency(),
      resolvedModel,
    };
  }

  const timer = setTimeout(() => resolveDone("timeout"), timeoutMs);
  const howItEnded = await done;
  clearTimeout(timer);
  controller.abort();
  await streamTask.catch(() => {});
  turns += 1;
  addUsage(usage);

  const replyText = lastCompleteText || assembleDeltas(deltaBuffers);
  const error = replyText
    ? null
    : scrub(
        streamError ??
          (howItEnded === "timeout"
            ? `等待智能体回复超时（${Math.round(timeoutMs / 1000)} 秒），已中止。`
            : "智能体没有返回可读的回复文本。"),
      );

  return {
    ok: Boolean(replyText) && !streamError,
    error: replyText ? null : error,
    invokedAt,
    replyText,
    eventCount,
    apiCalls: apiCalls - apiCallsBefore,
    durationMs: Date.now() - started,
    howItEnded,
    stopReason: lastStopReason,
    usage,
    toolEvents,
    latency: makeLatency(),
    resolvedModel,
  };
}

/**
 * 没有完整 message 事件时的兜底：按 event_start 的出现顺序拼各块增量。
 * reasoning 流与 message 流混在一起时会被一起拼上，所以只在兜底路径用。
 */
function assembleDeltas(buffers: Map<string, string[]>): string {
  const merged: string[] = [];
  for (const chunks of buffers.values()) merged.push(chunks.join(""));
  return merged.join("");
}
