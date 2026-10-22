import type { MatchStatus, OpeningStatus, VerifiedItinerary } from "@/lib/types";
import type {
  ConditionHit,
  HardConstraints,
  MissingEdge,
  NegotiationDiff,
  PartyConditions,
  Role,
  SoftRank,
  StopDisposition,
} from "@/lib/negotiation/types";

/** 浏览器只调站内地址；高德 key、令牌哈希与事实明细都留在服务端。 */
export const PLAN_COLLECTION = "/api/plan";
export const ROLE_TOKEN_HEADER = "x-plan-role-token";

export function planReadPath(planId: string): string {
  return `/api/plan/${encodeURIComponent(planId)}`;
}

export function planActionPath(planId: string, action: "conditions" | "propose" | "confirm" | "revoke" | "explain"): string {
  return `${planReadPath(planId)}/${action}`;
}

/**
 * 分享链接把令牌放在 URL fragment 里：fragment 不会发给服务端，也不会进访问日志。
 * 页面首帧读完后立刻清掉地址栏，此后令牌只走请求头。
 * 注意：fragment 与 sessionStorage 都不是安全边界——拿到链接的人就等于拿到访问权。
 */
export function buildPlanLink(origin: string, planId: string, role: Role, token: string): string {
  return `${origin}/plan/${encodeURIComponent(planId)}#r=${role}&t=${encodeURIComponent(token)}`;
}

export function readPlanLink(): { planId: string; role: Role; token: string } | null {
  if (typeof window === "undefined") return null;
  const match = /#r=([AB])&t=([^&]+)/.exec(window.location.hash);
  const pathId = /\/plan\/([^/?#]+)/.exec(window.location.pathname)?.[1] ?? null;
  if (!match || !pathId) return null;
  return { planId: decodeURIComponent(pathId), role: match[1] as Role, token: decodeURIComponent(match[2]) };
}

export function clearPlanFragment(): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

/** 从分享链接里取回 planId 与这一方的凭据（A、B 两条链接只差 role 与 token）。 */
export function parsePlanLink(link: string): { planId: string; role: Role; token: string } | null {
  const pathMatch = /\/plan\/([^/?#]+)/.exec(link);
  const hashMatch = /#r=([AB])&t=([^&]+)/.exec(link);
  if (!pathMatch || !hashMatch) return null;
  return { planId: decodeURIComponent(pathMatch[1]), role: hashMatch[1] as Role, token: decodeURIComponent(hashMatch[2]) };
}

const MAX_ID_LENGTH = 64;
const MAX_LIST_ITEMS = 12;
const SOFT_RANKS: SoftRank[] = ["prefer", "ok", "avoid", "follow"];
const BIASES = ["see_more", "walk_less", "neutral"] as const;

export type SanitizeResult = { ok: true; conditions: PartyConditions } | { ok: false; error: string };

/**
 * 条件录入的校验全部在这里确定性完成，不交给大模型解释：
 * 任何一项不认识或不合法就整体拒绝，不做静默替换、也不替用户补默认值。
 */
export function sanitizeConditions(raw: unknown, role: Role): SanitizeResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "conditions 必须是一个对象。" };
  const source = raw as Record<string, unknown>;
  const allowedTop = ["hard", "soft", "bias"];
  for (const key of Object.keys(source)) {
    if (!allowedTop.includes(key)) return { ok: false, error: `conditions 里出现了不认识的字段「${key.slice(0, 32)}」。` };
  }

  const hardRaw = (source.hard ?? {}) as Record<string, unknown>;
  const allowedHard = ["latestEndMinutes", "maxWalkMeters", "mustVisit", "neverAccept"];
  for (const key of Object.keys(hardRaw)) {
    if (!allowedHard.includes(key)) return { ok: false, error: `hard 里出现了不认识的字段「${key.slice(0, 32)}」。` };
  }

  const idList = (value: unknown, label: string): string[] | string => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return `${label} 必须是站点 id 数组。`;
    if (value.length > MAX_LIST_ITEMS) return `${label} 最多 ${MAX_LIST_ITEMS} 项。`;
    const ids: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || !item.trim()) return `${label} 里含有空的站点 id。`;
      if (item.length > MAX_ID_LENGTH) return `${label} 里的站点 id 超过 ${MAX_ID_LENGTH} 字符。`;
      ids.push(item.trim());
    }
    return ids;
  };

  const mustVisit = idList(hardRaw.mustVisit, "必须去 mustVisit");
  if (typeof mustVisit === "string") return { ok: false, error: mustVisit };
  const neverAccept = idList(hardRaw.neverAccept, "绝不接受 neverAccept");
  if (typeof neverAccept === "string") return { ok: false, error: neverAccept };

  const maxWalkMeters = hardRaw.maxWalkMeters;
  if (maxWalkMeters !== null && maxWalkMeters !== undefined) {
    if (typeof maxWalkMeters !== "number" || !Number.isInteger(maxWalkMeters) || maxWalkMeters < 200 || maxWalkMeters > 40_000) {
      return { ok: false, error: "步行上限必须是 200~40000 之间的整数米（统计口径见成本说明）。" };
    }
  }

  const latestEndMinutes = hardRaw.latestEndMinutes;
  if (latestEndMinutes !== null && latestEndMinutes !== undefined) {
    if (typeof latestEndMinutes !== "number" || !Number.isInteger(latestEndMinutes) || latestEndMinutes < 0 || latestEndMinutes > 1439) {
      return { ok: false, error: "最晚结束时刻必须是 0~1439 之间的整数（当天分钟数）。" };
    }
  }

  const hard: HardConstraints = {
    latestEndMinutes: typeof latestEndMinutes === "number" ? latestEndMinutes : null,
    maxWalkMeters: typeof maxWalkMeters === "number" ? maxWalkMeters : null,
    mustVisit,
    neverAccept,
  };

  const softRaw = (source.soft ?? {}) as Record<string, unknown>;
  if (Object.keys(softRaw).length > MAX_LIST_ITEMS) return { ok: false, error: `软偏好最多 ${MAX_LIST_ITEMS} 项。` };
  const soft: Record<string, SoftRank> = {};
  for (const [id, rank] of Object.entries(softRaw)) {
    if (id.length > MAX_ID_LENGTH || !id.trim()) return { ok: false, error: "软偏好里的站点 id 不合法。" };
    if (!SOFT_RANKS.includes(rank as SoftRank)) {
      return { ok: false, error: `「${id.slice(0, 32)}」的态度只能是 特别想去 / 可以去 / 不太想去 / 愿意跟随。` };
    }
    soft[id.trim()] = rank as SoftRank;
  }

  const bias = source.bias ?? "neutral";
  if (!BIASES.includes(bias as (typeof BIASES)[number])) {
    return { ok: false, error: "整体倾向只能是 多看几个 / 少走路 / 无所谓。" };
  }

  return { ok: true, conditions: { role, hard, soft, bias: bias as PartyConditions["bias"] } };
}

export function newAttemptId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `a-${Date.now()}-${Math.random()}`;
}

export interface RevisionView {
  revision: number;
  contentHash: string;
  kind: "proposal" | "committed";
  status: string;
  createdAt: string;
  suspended: { at: string; reason: string } | null;
  confirmations: { A: { at: string } | null; B: { at: string } | null };
  itinerary: VerifiedItinerary;
  diff: NegotiationDiff | null;
  satisfied: ConditionHit[];
  unmet: ConditionHit[];
  unverified: string[];
  dispositions: StopDisposition[];
  missingEdges: MissingEdge[];
  extraLegsNeeded: number;
  note: string;
  conditionsSnapshot: { A: PartyConditions; B: PartyConditions | null };
  outcome: string;
  hardConflict: { byRole: string; constraint: string; evidence: string[] } | null;
}

export interface PlanSnapshot {
  planId: string;
  role: Role;
  status: string;
  headRevision: number | null;
  officialRevision: number | null;
  canExecute: { allowed: boolean; reason: string };
  head: RevisionView | null;
  official: RevisionView | null;
  attempts: {
    attemptId: string;
    role: Role;
    kind: string;
    status: string;
    detail: string;
    legsSpent: number;
    simulated: boolean;
    missingEdges: MissingEdge[];
    createdAt: string;
  }[];
  conditions: { A: PartyConditions; B: PartyConditions | null };
  budget: {
    spentThisPlan: number;
    logicalRequests: number;
    httpRetries: number;
    perResolveHardMax: number;
    perPlanHardMax: number;
    approvalThreshold: number;
    hourlyHeadroomWalking: number;
  };
  facts: {
    factsId: string;
    cityName: string;
    categories: string[];
    poolSize: number;
    measuredPairs: number;
    startLegs: number;
    failedPairs: number;
    measuredAt: string;
  };
  pool: {
    id: string;
    name: string;
    matchStatus: MatchStatus;
    openingStatus: OpeningStatus;
    openingNote: string;
    straightLineMeters: number;
  }[];
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  /** 本小时剩余额度与实例标识：用于如实告知「换实例＝方案丢失」，不含任何密钥 */
  amap?: {
    placeHourlyUsed: number;
    placeHourlyCap: number;
    walkingHourlyUsed: number;
    walkingHourlyCap: number;
    cacheEntries: number;
  };
  stores?: { plans: number; facts: number };
  /** 最小快照的落盘状态：换实例仍然会丢，但同机重启不再等于协商全部作废 */
  persist?: {
    file: string;
    exists: boolean;
    bytes: number;
    writtenAt: string | null;
    plans: number;
    restored: {
      status: string;
      detail: string | null;
      loaded: number;
      skipped: { expiredPlan: number; corrupt: number };
    } | null;
  };
  pid: number;
  serverTime: string;
}

export interface MutationView {
  code: string;
  message: string;
  revision: RevisionView | null;
  diff: NegotiationDiff | null;
  missingEdges: MissingEdge[];
}
