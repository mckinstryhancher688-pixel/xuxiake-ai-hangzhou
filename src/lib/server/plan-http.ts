import { amapCounters } from "./amap";
import { factsStoreStatus } from "./facts";
import { planPersistenceStatus, planSnapshot, planStoreStatus } from "./plan-store";
import { ROLE_TOKEN_HEADER, type MutationView, type PlanSnapshot } from "@/lib/plan-api";
import type { MutationResult } from "@/lib/negotiation/plan-state";
import type { Role } from "@/lib/negotiation/types";

export const MAX_BODY_BYTES = 8_192;
export const MAX_ID_LENGTH = 64;

/** 401＝你没带对凭据（不区分缺失与错误，避免枚举）；410＝链接已作废。 */
export const AUTH_FAILURE: Record<string, { status: number; message: string }> = {
  "unknown-plan": { status: 410, message: "这个协商方案在本实例上已经找不到了（服务重启或超出保留期）。重新核验会真实消耗高德请求，所以这里不自动重跑。" },
  revoked: { status: 410, message: "发起方已撤销这条链接，两条角色链接同时失效。" },
  expired: { status: 410, message: "协商方案已过期（保留 72 小时）。" },
  "bad-token": { status: 401, message: "角色凭据缺失或不正确。请重新打开分享链接。" },
};

/** 状态码映射：协商结果本身就是数据，只有需要客户端换动作的才用 4xx/5xx。 */
const MUTATION_STATUS: Record<string, number> = {
  ok: 200,
  "idempotent-replay": 200,
  "no-solution": 200,
  "stale-revision": 409,
  "not-confirmable": 409,
  quota: 422,
  "cost-approval-needed": 202,
  "measurement-failed": 502,
  "plan-dead": 410,
  "persist-failed": 500,
};

export function statusFor(code: string): number {
  return MUTATION_STATUS[code] ?? 200;
}

export type ExpectedRevision = { ok: true; value: number | null } | { ok: false; error: string };

/** CAS 版本号必须显式给出：漏字段就让请求失败，不猜客户端想看哪一版。 */
export function parseExpectedRevision(value: unknown): ExpectedRevision {
  if (value === undefined) return { ok: false, error: "必须带 expectedRevision（还没有版本时传 null）。" };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 999) {
    return { ok: false, error: "expectedRevision 必须是 0~999 的整数或 null。" };
  }
  return { ok: true, value };
}

const SAFE_HOST = /^[A-Za-z0-9.\-]+(?::\d{1,5})?$/;

/**
 * 分享链接里的主机必须就是浏览器实际访问的那个（局域网 IP 会变），
 * 但 Host 是客户端可控头，所以只接受形状合法的值，否则退回请求自身的 host。
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const candidate = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const host = SAFE_HOST.test(candidate) ? candidate : url.host;
  const forwarded = request.headers.get("x-forwarded-proto");
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : "http";
  return `${proto}://${host}`;
}

export function readToken(request: Request): string | null {
  const value = request.headers.get(ROLE_TOKEN_HEADER);
  if (!value || value.length > MAX_ID_LENGTH * 2) return null;
  return value;
}

export function authFailure(code: keyof typeof AUTH_FAILURE) {
  const entry = AUTH_FAILURE[code] ?? AUTH_FAILURE["bad-token"];
  return Response.json({ error: entry.message, code }, { status: entry.status });
}

export type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

export async function readBoundedJson(request: Request): Promise<BodyResult> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return { ok: false, response: Response.json({ error: `请求体过大（上限 ${MAX_BODY_BYTES} 字节）。` }, { status: 413 }) };
  }
  if (!raw) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, response: Response.json({ error: "请求体必须是一个 JSON 对象。" }, { status: 400 }) };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: Response.json({ error: "请求体不是合法 JSON。" }, { status: 400 }) };
  }
}

export function shortId(value: unknown, label: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) {
    return `${label} 缺失或超过 ${MAX_ID_LENGTH} 字符。`;
  }
  return trimmed;
}

/** 快照 + 如实暴露的额度与实例信息（不含任何密钥；keyMask 由 /api/verify 那边给）。 */
export function buildSnapshot(planId: string, role: Role): PlanSnapshot | null {
  const base = planSnapshot(planId, role);
  if (!base) return null;
  const counters = amapCounters();
  return {
    ...base,
    amap: {
      placeHourlyUsed: counters.placeCalls,
      placeHourlyCap: counters.placeHourlyCap,
      walkingHourlyUsed: counters.walkingCalls,
      walkingHourlyCap: counters.walkingHourlyCap,
      cacheEntries: counters.cacheEntries,
    },
    stores: { plans: planStoreStatus().entries, facts: factsStoreStatus().entries },
    persist: planPersistenceStatus(),
    pid: process.pid,
    serverTime: new Date().toISOString(),
  };
}

export function viewOf(result: MutationResult): MutationView {
  const revision = result.revision;
  return {
    code: result.code,
    message: result.message,
    missingEdges: result.missingEdges,
    diff: revision?.diff ?? null,
    revision: revision
      ? {
          revision: revision.revision,
          contentHash: revision.contentHash,
          kind: revision.kind,
          status: revision.status,
          createdAt: revision.createdAt,
          suspended: revision.suspended,
          confirmations: {
            A: revision.confirmations.A ? { at: revision.confirmations.A.at } : null,
            B: revision.confirmations.B ? { at: revision.confirmations.B.at } : null,
          },
          itinerary: { ...revision.itinerary, legs: revision.itinerary.legs.map((leg) => ({ ...leg, polyline: [] })) },
          diff: revision.diff,
          satisfied: revision.solve.satisfied,
          unmet: revision.solve.unmet,
          unverified: revision.solve.unverified,
          dispositions: revision.solve.dispositions,
          missingEdges: revision.solve.missingEdges,
          extraLegsNeeded: revision.solve.extraLegsNeeded,
          note: revision.solve.note,
          conditionsSnapshot: revision.conditionsSnapshot,
          outcome: revision.solve.kind,
          hardConflict: revision.solve.hardConflict,
        }
      : null,
  };
}
