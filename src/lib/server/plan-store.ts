import { amapCounters, planWalking } from "./amap";
import { factsStoreStatus, getFactSet, restoreFactSet, type FactSummary } from "./facts";
import { mintPlanId, mintRoleToken, hashCredential, credentialMatches } from "./plan-tickets";
import {
  loadSnapshot,
  persistSnapshot,
  snapshotInfo,
  type PersistedPlan,
  type SaveResult,
} from "./plan-snapshot";
import { toLeg } from "@/lib/itinerary-compose";
import {
  createPlan,
  confirmRevision,
  canExecute,
  executionRoute,
  headRevisionOf,
  officialRevisionOf,
  proposeRoute as proposeRouteState,
  submitConditions as submitConditionsState,
  type Attempt,
  type MutationResult,
  type PlanState,
  type Revision,
} from "@/lib/negotiation/plan-state";
import {
  FACT_START_KEY,
  type FactEntry,
  type FactSet,
  type MissingEdge,
  type PartyConditions,
  type Role,
} from "@/lib/negotiation/types";
import type { LatLng, VerifiedItinerary } from "@/lib/types";

if (typeof window !== "undefined") {
  throw new Error("lib/server/plan-store 只能在 Next.js 服务端加载。");
}

/**
 * 双人协商的服务端账本。
 *
 * 与既有缓存同一条命：全部在进程内存里，**不承诺跨重启或跨实例恢复**。
 * 读不到 plan 时端点如实返回 410「方案已失效」，界面必须报价后再让用户决定是否重新核验，
 * 绝不静默重跑一次付费流程装作什么都没发生。
 */
const PLAN_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_PLANS = 24;

interface PlanRecord {
  state: PlanState;
  facts: FactSet;
  /** 只存哈希；令牌本身只在创建响应里出现过一次 */
  tokenHashes: { A: string; B: string };
  createdAt: number;
  /** 本方案一小时内的写入时间戳，防止令牌被转发后无限刷 */
  writes: number[];
  /** 每个方案一把串行锁：补测→求解→提交必须整体串行，避免两人同时为同一段付费 */
  lock: Promise<unknown>;
}

const plans = new Map<string, PlanRecord>();

/**
 * 首次被碰到时从磁盘快照恢复一次。
 *
 * 恢复的是「我们确实测过什么、双方确实确认到哪一版」，不是重新花钱：
 * 事实层按原始采集时间续用有效期，过期就照实失效。文件损坏或校验不过时
 * 整份拒绝恢复，并把原因留在 planStoreStatus 里，不拿半截状态当真。
 */
let restoreTried = false;
let restoreNote: { status: string; detail: string | null; loaded: number; skipped: { expiredPlan: number; corrupt: number } } | null = null;

function ensureRestored(): void {
  if (restoreTried) return;
  restoreTried = true;
  const loaded = loadSnapshot();
  restoreNote = { status: loaded.status, detail: loaded.detail, loaded: 0, skipped: loaded.skipped };
  if (loaded.status !== "loaded") return;
  for (const plan of loaded.plans) {
    if (plans.has(plan.planId)) continue;
    restoreFactSet(plan.facts);
    plans.set(plan.planId, {
      state: plan.state,
      facts: plan.facts,
      tokenHashes: plan.tokenHashes,
      createdAt: plan.createdAt,
      writes: [],
      lock: Promise.resolve(),
    });
    restoreNote.loaded += 1;
  }
}

function recordOf(planId: string): PlanRecord | null {
  ensureRestored();
  prunePlans();
  return plans.get(planId) ?? null;
}

function collectPlans(): PersistedPlan[] {
  ensureRestored();
  return [...plans.entries()].map(([planId, record]) => ({
    planId,
    state: record.state,
    facts: record.facts,
    tokenHashes: record.tokenHashes,
    createdAt: record.createdAt,
  }));
}

/** 把当前协商状态原子落盘。关键状态必须写成功才对用户说「好了」。 */
export async function persistPlansNow(): Promise<SaveResult> {
  ensureRestored();
  return persistSnapshot(collectPlans());
}

function prunePlans(): void {
  const cutoff = Date.now() - PLAN_TTL_MS;
  for (const [id, record] of plans) {
    if (record.createdAt < cutoff) plans.delete(id);
  }
  while (plans.size > MAX_PLANS) {
    const oldest = [...plans.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    plans.delete(oldest[0]);
  }
}

export type AuthCode = "ok" | "unknown-plan" | "bad-token" | "expired" | "revoked";

/**
 * 角色由令牌决定，不由请求体声明：
 * 请求里写着「我是 A」没有意义，能拿出 A 令牌的人才是 A。
 */
export function identifyRole(planId: string, token: string | null): { role: Role } | { error: AuthCode } {
  ensureRestored();
  prunePlans();
  const record = recordOf(planId);
  if (!record) return { error: "unknown-plan" };
  if (record.state.revoked) return { error: "revoked" };
  if (new Date(record.state.expiresAt).getTime() <= Date.now()) return { error: "expired" };
  if (token) {
    if (credentialMatches(token, record.tokenHashes.A)) return { role: "A" };
    if (credentialMatches(token, record.tokenHashes.B)) return { role: "B" };
  }
  return { error: "bad-token" };
}

const WRITE_LIMIT_PER_HOUR = 40;

/** 按 plan 维度的写次数上限：令牌是访问凭据，被转发出去也不能无限刷。 */
export function noteWrite(planId: string): { allowed: boolean; reason: string | null } {
  const record = recordOf(planId);
  if (!record) return { allowed: false, reason: "方案已失效。" };
  const cutoff = Date.now() - 60 * 60 * 1000;
  record.writes = record.writes.filter((at) => at > cutoff);
  if (record.writes.length >= WRITE_LIMIT_PER_HOUR) {
    return { allowed: false, reason: `本方案一小时内已达写入上限（${WRITE_LIMIT_PER_HOUR} 次），请稍后再试。` };
  }
  record.writes.push(Date.now());
  return { allowed: true, reason: null };
}

export function planExists(planId: string): boolean {
  ensureRestored();
  prunePlans();
  return plans.has(planId);
}

export function createPlanRecord(input: {
  facts: FactSet;
  conditionsA: PartyConditions;
  now: Date;
}): { planId: string; tokens: { A: string; B: string }; state: PlanState } {
  ensureRestored();
  prunePlans();
  const planId = mintPlanId();
  const tokens = { A: mintRoleToken(), B: mintRoleToken() };
  const state = createPlan(planId, input.facts, input.conditionsA, input.now);
  state.expiresAt = new Date(input.now.getTime() + PLAN_TTL_MS).toISOString();
  plans.set(planId, {
    state,
    facts: input.facts,
    tokenHashes: { A: hashCredential(tokens.A), B: hashCredential(tokens.B) },
    createdAt: Date.now(),
    writes: [],
    lock: Promise.resolve(),
  });
  return { planId, tokens, state };
}

export function authorize(planId: string, role: Role, token: string | null): AuthCode {
  ensureRestored();
  prunePlans();
  const record = recordOf(planId);
  if (!record) return "unknown-plan";
  if (record.state.revoked) return "revoked";
  if (new Date(record.state.expiresAt).getTime() <= Date.now()) return "expired";
  if (!token) return "bad-token";
  return credentialMatches(token, record.tokenHashes[role]) ? "ok" : "bad-token";
}

/** 读事实集：plan 还在但事实已过期时返回 null，由端点如实报失效。 */
function liveFacts(record: PlanRecord): FactSet | null {
  // getFactSet 会刷新内存访问时间；轮询不能因此延长原始实测事实的有效期。
  const measuredAt = Date.parse(record.facts.measuredAt);
  const ttlMs = factsStoreStatus().ttlSeconds * 1000;
  if (!Number.isFinite(measuredAt) || Date.now() - measuredAt >= ttlMs) return null;
  return getFactSet(record.facts.factsId);
}

export function withPlanLock<T>(planId: string, task: () => Promise<T>): Promise<T> {
  const record = recordOf(planId);
  if (!record) return task();
  const run = record.lock.then(task, task);
  record.lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 真实补测：只在成本批准后才会被调用。缺边的坐标全部来自事实集，不接受客户端传坐标。 */
async function measureViaAmap(
  facts: FactSet,
  edges: MissingEdge[],
): Promise<{ ok: boolean; legs: Record<string, FactEntry>; error: string | null; retries: number }> {
  const stopOf = (id: string) => (id === FACT_START_KEY ? null : facts.pool.find((item) => item.id === id) ?? null);
  const positionOf = (id: string): LatLng | null => (id === FACT_START_KEY ? facts.start.position : stopOf(id)?.position ?? null);
  const nameOf = (id: string): string => (id === FACT_START_KEY ? facts.start.name : stopOf(id)?.name ?? id);

  const legs: Record<string, FactEntry> = {};
  let retries = 0;
  const errors: string[] = [];
  for (const edge of edges) {
    const [fromId, toId] = edge.key.split("->");
    const from = positionOf(fromId);
    const to = positionOf(toId);
    if (!from || !to) {
      errors.push(`${edge.name}：事实集里没有可用坐标`);
      continue;
    }
    const result = await planWalking(from, to);
    retries += result.entry.retries;
    if (!result.ok || !result.data) {
      errors.push(`${edge.name}：${result.error ?? "高德无返回"}`);
      continue;
    }
    legs[edge.key] = {
      measuredAt: new Date().toISOString(),
      leg: toLeg(nameOf(fromId), nameOf(toId), from, to, result.data, result.entry.fromCache),
    };
  }
  return { ok: errors.length === 0, legs, error: errors.length ? errors.join("；") : null, retries };
}

function currentHeadroom(): number {
  const counters = amapCounters();
  return Math.max(0, counters.walkingHourlyCap - counters.walkingCalls);
}

function refreshBudgetWindow(state: PlanState): void {
  state.budget.hourlyHeadroomWalking = currentHeadroom();
}

export type PlanMutation =
  | { kind: "conditions"; role: Role; conditions: PartyConditions; expectedRevision: number | null; attemptId: string; confirmCost: boolean; expectedCostKey?: string }
  | { kind: "propose"; role: Role; expectedRevision: number | null; attemptId: string }
  | { kind: "confirm"; role: Role; revision: number; contentHash: string }
  | { kind: "revoke"; role: Role };

function stripGeometry(itinerary: VerifiedItinerary): VerifiedItinerary {
  return {
    ...itinerary,
    legs: itinerary.legs.map((leg) => ({ ...leg, polyline: [] })),
  };
}

function revisionView(revision: Revision | null) {
  if (!revision) return null;
  return {
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
    itinerary: stripGeometry(revision.itinerary),
    diff: revision.diff,
    satisfied: revision.solve.satisfied,
    unmet: revision.solve.unmet,
    unverified: revision.solve.unverified,
    dispositions: revision.solve.dispositions,
    missingEdges: revision.solve.missingEdges,
    extraLegsNeeded: revision.solve.extraLegsNeeded,
    note: revision.solve.note,
    /** 这版是拿哪些条件算出来的，双方确认前必须看得见 */
    conditionsSnapshot: revision.conditionsSnapshot,
    outcome: revision.solve.kind,
    hardConflict: revision.solve.hardConflict,
  };
}

export function planSnapshot(planId: string, role: Role) {
  const record = recordOf(planId);
  if (!record) return null;
  const { state, facts } = record;
  const execution = liveFacts(record)
    ? canExecute(state, new Date())
    : { allowed: false, reason: "已核验事实已过期或在本实例上不可用，请重新核验后再协商确认；这里不会自动调用高德。" };
  return {
    planId,
    role,
    status: state.status,
    headRevision: state.headRevision,
    officialRevision: state.officialRevision,
    canExecute: execution,
    head: revisionView(headRevisionOf(state)),
    official: revisionView(officialRevisionOf(state)),
    attempts: state.attempts.slice(-6).map((attempt: Attempt) => ({
      attemptId: attempt.attemptId,
      role: attempt.role,
      kind: attempt.kind,
      status: attempt.status,
      detail: attempt.detail,
      legsSpent: attempt.legsSpent,
      simulated: attempt.simulated,
      missingEdges: attempt.missingEdges,
      createdAt: attempt.createdAt,
    })),
    conditions: state.conditions,
    budget: {
      spentThisPlan: state.budget.spentThisPlan,
      logicalRequests: state.budget.logicalRequests,
      httpRetries: state.budget.httpRetries,
      perResolveHardMax: state.budget.perResolveHardMax,
      perPlanHardMax: state.budget.perPlanHardMax,
      approvalThreshold: state.budget.approvalThreshold,
      hourlyHeadroomWalking: currentHeadroom(),
    },
    facts: factsSummaryOfStore(facts),
    pool: facts.pool.map((item) => ({
      id: item.id,
      name: item.name,
      matchStatus: item.matchStatus,
      openingStatus: item.openingStatus,
      openingNote: item.openingNote,
      straightLineMeters: item.straightLineMeters,
    })),
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
    revoked: state.revoked,
  };
}

function factsSummaryOfStore(facts: FactSet): FactSummary {
  const keys = Object.keys(facts.legs);
  return {
    factsId: facts.factsId,
    cityName: facts.cityName,
    categories: [...facts.categories],
    poolSize: facts.pool.length,
    measuredPairs: keys.filter((key) => !key.startsWith(`${FACT_START_KEY}->`)).length,
    startLegs: keys.filter((key) => key.startsWith(`${FACT_START_KEY}->`)).length,
    failedPairs: facts.failedPairs.length,
    measuredAt: facts.measuredAt,
  };
}

async function applyPlanMutation(planId: string, mutation: PlanMutation): Promise<MutationResult> {
  const record = recordOf(planId);
  if (!record) return { code: "plan-dead", message: "方案已失效（服务重启或超出保留期）。", revision: null, solve: null, diff: null, missingEdges: [] };
  const now = new Date();
  refreshBudgetWindow(record.state);

  if (mutation.kind === "revoke") {
    record.state.revoked = true;
    record.state.status = "revoked";
    return { code: "ok", message: "方案已撤销，两条角色链接立即失效。", revision: null, solve: null, diff: null, missingEdges: [] };
  }

  if (mutation.kind === "confirm") {
    return confirmRevision(record.state, { role: mutation.role, revision: mutation.revision, contentHash: mutation.contentHash, now });
  }

  const measure = async (edges: MissingEdge[]) => {
    const outcome = await measureViaAmap(record.facts, edges);
    return outcome.ok
      ? { ok: true as const, legs: outcome.legs, retries: outcome.retries }
      : { ok: false as const, error: outcome.error ?? "高德无返回", retries: outcome.retries, simulated: false, legs: outcome.legs };
  };

  if (mutation.kind === "conditions") {
    return submitConditionsState(record.state, record.facts, {
      role: mutation.role,
      conditions: mutation.conditions,
      expectedRevision: mutation.expectedRevision,
      attemptId: mutation.attemptId,
      confirmCost: mutation.confirmCost,
      expectedCostKey: mutation.expectedCostKey,
      now,
      measure,
    });
  }

  return proposeRouteState(record.state, record.facts, {
    role: mutation.role,
    expectedRevision: mutation.expectedRevision,
    attemptId: mutation.attemptId,
    now,
    measure,
  });
}

/**
 * 所有会改状态的动作都从这里出去：先改内存，再原子落盘。
 * 落盘失败时不能对用户说「已生效」——条件、确认、撤销这几步都要求先保存成功。
 */
export async function runPlanMutation(planId: string, mutation: PlanMutation): Promise<MutationResult> {
  const result = await applyPlanMutation(planId, mutation);
  const saved = await persistPlansNow();
  if (!saved.ok && result.code === "ok") {
    return {
      ...result,
      code: "persist-failed",
      message: `状态已经在内存里改掉了，但快照没能写入（${saved.error}）。这一步不能算已保存，请重试。`,
    };
  }
  return result;
}

/** 事实集可能比 plan 先过期；这里给出可读的失效原因，不静默重建。 */
export function factsStillLive(planId: string): boolean {
  const record = recordOf(planId);
  if (!record) return false;
  return liveFacts(record) !== null;
}

export interface PlanJourney {
  facts: FactSet;
  itinerary: VerifiedItinerary;
  officialRevision: number;
  cityName: string;
  categories: string[];
}

/**
 * 双人模式下的「当前正式执行行程」。
 *
 * 门禁不放行（未确认、已挂起、核验失败、违反现行硬条件、事实已过期）时返回 null，
 * 调用方必须如实拒绝，绝不退回 city/categories 的那条单人路线去顶数。
 */
export function planExecutionJourney(planId: string): PlanJourney | null {
  const record = recordOf(planId);
  if (!record) return null;
  const facts = liveFacts(record);
  if (!facts) return null;
  const itinerary = executionRoute(record.state, new Date());
  if (!itinerary || record.state.officialRevision === null) return null;
  return { facts, itinerary, officialRevision: record.state.officialRevision, cityName: facts.cityName, categories: [...facts.categories] };
}

/** 门禁为什么还没开：给界面与日志一个服务端原话，不用界面自己猜。 */
export function executionBlockReason(planId: string): string {
  const record = recordOf(planId);
  if (!record) return "方案已失效（服务重启、已撤销或超出保留期）。";
  if (!liveFacts(record)) return "事实层已过期，需要重新核验后才能继续这条协商。";
  return canExecute(record.state, new Date()).reason;
}

/** AI 解释读的是整份状态（含未确认版本）：解释不等于执行。 */
export function planForBrief(planId: string): { state: PlanState; facts: FactSet } | null {
  const record = recordOf(planId);
  if (!record) return null;
  const facts = liveFacts(record);
  if (!facts) return null;
  return { state: record.state, facts };
}

export function planStoreStatus(): { entries: number; ttlSeconds: number } {
  ensureRestored();
  prunePlans();
  return { entries: plans.size, ttlSeconds: Math.round(PLAN_TTL_MS / 1000) };
}

/** 快照落到了哪儿、本进程启动时恢复了多少：状态接口与调试面板用。 */
export function planPersistenceStatus(): {
  file: string;
  exists: boolean;
  bytes: number;
  writtenAt: string | null;
  plans: number;
  restored: { status: string; detail: string | null; loaded: number; skipped: { expiredPlan: number; corrupt: number } } | null;
} {
  ensureRestored();
  return { ...snapshotInfo(), restored: restoreNote };
}
