import { maskId, maskKey } from "./bailian";
import {
  UNDERSTAND_SYSTEM_PROMPT,
  fallbackUnderstanding,
  judgeModelReply,
  type Understanding,
} from "@/lib/understand";

if (typeof window !== "undefined") {
  throw new Error("lib/server/understand 只能在 Next.js 服务端加载。");
}

/**
 * 读「说说爸妈的情况」那一句话：百炼 OpenAI 兼容接口，一次请求。
 *
 * 为什么不走现有的托管智能体（lib/server/agent.ts）：那条链路一回合要建会话、订阅 SSE、提交消息三次请求，
 * 也没法强制返回固定格式。这里只需要「分类 + 一句追问」，所以单独用 chat/completions：
 * 强制 json_object、关思考模式、temperature 0。托管智能体那边（讲解、少走一点）没有改动。
 *
 * 付费纪律：每读一句话是 1 次真实的模型调用；有独立的小时上限，超限直接拒绝，不发请求。
 * 隐私：用户原话只发给百炼，不写日志；日志里只有时间、状态码、耗时与 token 数。
 */

const DEFAULT_REGION = "cn-beijing";
/** qwen-flash 系列默认不开思考、非思考模式支持 json_object（百炼「结构化输出」文档） */
const DEFAULT_MODEL = "qwen-flash";
const REQUEST_TIMEOUT_MS = 20_000;
export const UNDERSTAND_HOURLY_CAP = 60;
const LOG_LIMIT = 20;

export const UNDERSTAND_VAR_NAMES = ["DASHSCOPE_API_KEY", "BAILIAN_WORKSPACE_ID"] as const;

interface UnderstandConfig {
  key: string;
  workspace: string;
  model: string;
  /** 未脱敏，只在本模块内部拼 URL 用 */
  endpoint: string;
}

function readConfig(): { config: UnderstandConfig | null; missing: string[] } {
  const missing = UNDERSTAND_VAR_NAMES.filter((name) => !process.env[name]?.trim());
  if (missing.length) return { config: null, missing };
  const key = process.env.DASHSCOPE_API_KEY!.trim();
  const workspace = process.env.BAILIAN_WORKSPACE_ID!.trim();
  const region = process.env.BAILIAN_REGION?.trim() || DEFAULT_REGION;
  const model = process.env.BAILIAN_UNDERSTAND_MODEL?.trim() || DEFAULT_MODEL;
  return {
    config: {
      key,
      workspace,
      model,
      endpoint: `https://${workspace}.${region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`,
    },
    missing: [],
  };
}

function scrubber(config: UnderstandConfig): (text: unknown) => string {
  return (text) => {
    let out = typeof text === "string" ? text : String(text ?? "");
    if (config.key) out = out.split(config.key).join(maskKey(config.key) ?? "****");
    if (config.workspace) out = out.split(config.workspace).join(maskId(config.workspace));
    return out;
  };
}

/* ── 计数：GET /api/understand 原样展示 ─────────────────────────── */

interface UnderstandLogEntry {
  at: string;
  httpStatus: number | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** 结论类别；不含用户原话 */
  outcome: Understanding["kind"] | "failed" | "rejected";
  error: string | null;
}

let modelCalls = 0;
let failedCalls = 0;
let rejectedCalls = 0;
let inputTokensTotal = 0;
let outputTokensTotal = 0;
const stamps: number[] = [];
const log: UnderstandLogEntry[] = [];

function callsLastHour(): number {
  const now = Date.now();
  while (stamps.length && stamps[0] < now - 3_600_000) stamps.shift();
  return stamps.length;
}

function pushLog(entry: UnderstandLogEntry): void {
  log.push(entry);
  if (log.length > LOG_LIMIT) log.shift();
}

export interface UnderstandStatus {
  configured: boolean;
  missingVars: string[];
  model: string | null;
  modelCalls: number;
  failedCalls: number;
  rejectedCalls: number;
  callsLastHour: number;
  hourlyCap: number;
  inputTokens: number;
  outputTokens: number;
  log: UnderstandLogEntry[];
}

export function understandStatus(): UnderstandStatus {
  const { config, missing } = readConfig();
  return {
    configured: config !== null,
    missingVars: missing,
    model: config?.model ?? null,
    modelCalls,
    failedCalls,
    rejectedCalls,
    callsLastHour: callsLastHour(),
    hourlyCap: UNDERSTAND_HOURLY_CAP,
    inputTokens: inputTokensTotal,
    outputTokens: outputTokensTotal,
    log: log.map((entry) => ({ ...entry })),
  };
}

export interface UnderstandResult {
  understanding: Understanding;
  /** true = 没有拿到模型的有效结论，给的是默认问题 */
  degraded: boolean;
  /** 脱敏后的真实错误；没出错为 null */
  error: string | null;
  model: string | null;
  cost: { modelCalls: number; inputTokens: number; outputTokens: number };
}

const NO_COST = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };

export async function understandText(text: string): Promise<UnderstandResult> {
  const { config, missing } = readConfig();
  if (!config) {
    return {
      understanding: fallbackUnderstanding("百炼配置不完整"),
      degraded: true,
      error: `缺少环境变量：${missing.join("、")}`,
      model: null,
      cost: NO_COST,
    };
  }

  // 上限挡在请求发出之前：被拒绝的不产生费用，也不计入调用次数
  if (callsLastHour() >= UNDERSTAND_HOURLY_CAP) {
    rejectedCalls += 1;
    const error = `本小时读句子的次数已达上限（${UNDERSTAND_HOURLY_CAP} 次），没有发起新的付费调用。`;
    pushLog({ at: new Date().toISOString(), httpStatus: null, durationMs: 0, inputTokens: 0, outputTokens: 0, outcome: "rejected", error });
    return {
      understanding: fallbackUnderstanding("本小时次数已用完"),
      degraded: true,
      error,
      model: config.model,
      cost: NO_COST,
    };
  }

  stamps.push(Date.now());
  modelCalls += 1;
  const scrub = scrubber(config);
  const started = Date.now();
  const at = new Date().toISOString();

  const fail = (httpStatus: number | null, error: string, userReason: string): UnderstandResult => {
    failedCalls += 1;
    const safe = scrub(error);
    pushLog({ at, httpStatus, durationMs: Date.now() - started, inputTokens: 0, outputTokens: 0, outcome: "failed", error: safe });
    return {
      understanding: fallbackUnderstanding(userReason),
      degraded: true,
      error: safe,
      model: config.model,
      // 请求已经发出：即便失败也如实记 1 次调用（可能已计费，以百炼账单为准）
      cost: { modelCalls: 1, inputTokens: 0, outputTokens: 0 },
    };
  };

  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: UNDERSTAND_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
        enable_thinking: false,
        temperature: 0,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return fail(null, `请求百炼失败：${message}`, "连不上百炼");
  }

  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    let code = "";
    try {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const nested = body.error as Record<string, unknown> | undefined;
      code = String(nested?.code ?? body.code ?? "");
    } catch {
      code = "";
    }
    return fail(response.status, `百炼返回 HTTP ${response.status}${code ? ` ${code}` : ""}`, `百炼返回错误 ${response.status}`);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fail(response.status, `百炼返回的不是 JSON：${raw.slice(0, 120)}`, "百炼返回的格式不对");
  }
  const choices = Array.isArray(body.choices) ? (body.choices as Record<string, unknown>[]) : [];
  const message = choices[0]?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  const usage = (body.usage ?? {}) as Record<string, unknown>;
  const inputTokens = Number(usage.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? 0) || 0;
  inputTokensTotal += inputTokens;
  outputTokensTotal += outputTokens;

  const understanding = judgeModelReply(text, content);
  // 模型回了 200 但内容不符合约定格式时，judgeModelReply 会退回默认问题；这种情况记成 degraded，如实展示
  const degraded = understanding.source === "fallback";
  pushLog({
    at,
    httpStatus: response.status,
    durationMs: Date.now() - started,
    inputTokens,
    outputTokens,
    outcome: understanding.kind,
    error: degraded ? "模型返回的内容不符合约定格式" : null,
  });
  return {
    understanding,
    degraded,
    error: degraded ? "模型返回的内容不符合约定格式" : null,
    model: typeof body.model === "string" ? body.model : config.model,
    cost: { modelCalls: 1, inputTokens, outputTokens },
  };
}
