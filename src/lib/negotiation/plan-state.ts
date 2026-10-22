import type { VerifiedItinerary } from "@/lib/types";
import { diffItineraries } from "./diff.ts";
import { estimateMissingEdges, solveJoint } from "./solve.ts";
import {
  type FactEntry,
  type FactSet,
  type JointSolve,
  type MissingEdge,
  type NegotiationDiff,
  type PartyConditions,
  type Role,
} from "./types.ts";

/**
 * 硬上限：confirmCost 越不过这三个数。
 * 9 是「起点→新站 + 新站↔最近 4 站双向」的上界，实际扣减按去重后的缺边数。
 */
export const HARD_CAP_PER_RESOLVE = 9;
export const HARD_CAP_PER_PLAN = 18;
/** 建议支出阈值：只有它能被 A 的成本批准越过。 */
export const APPROVAL_THRESHOLD = 6;

export type PlanStatus =
  | "draft"
  | "negotiating"
  | "awaiting-confirmation"
  | "jointly-confirmed"
  | "paused"
  | "awaiting-cost-approval"
  | "expired"
  | "revoked"
  | "lost";

export type RevisionStatus =
  | "pending-review"
  | "confirmed-one"
  | "jointly-confirmed"
  | "superseded"
  | "rolled-back-content";

export type AttemptStatus =
  | "succeeded"
  | "rejected:stale-revision"
  | "rejected:quota"
  | "awaiting-cost-approval"
  | "rejected:measurement-failed"
  | "rejected:hard-conflict"
  | "rejected:not-measured"
  | "rejected:constraint-invalid"
  | "rejected:not-confirmable"
  | "rejected:plan-dead";

export interface Confirmation {
  contentHash: string;
  at: string;
}

export interface Revision {
  revision: number;
  contentHash: string;
  /** proposal = 「少走一点」这类不改条件的提案；committed = 条件变更后的新求解 */
  kind: "proposal" | "committed";
  status: RevisionStatus;
  itinerary: VerifiedItinerary;
  solve: JointSolve;
  diff: NegotiationDiff | null;
  conditionsSnapshot: { A: PartyConditions; B: PartyConditions | null };
  createdAt: string;
  confirmations: Record<Role, Confirmation | null>;
  suspended: { at: string; reason: string } | null;
}

export interface Attempt {
  attemptId: string;
  role: Role;
  kind: "update-conditions" | "propose-route" | "confirm";
  status: AttemptStatus;
  detail: string;
  /** 本次实际消耗的逻辑请求数（去重后的真实缺边） */
  legsSpent: number;
  missingEdges: MissingEdge[];
  /** 夹具注入的失败必须打上标记，绝不冒充真实高德返回 */
  simulated: boolean;
  createdAt: string;
}

export interface Budget {
  perResolveHardMax: number;
  perPlanHardMax: number;
  approvalThreshold: number;
  /** 服务端从小时窗口读出的步行余量；这是第三个硬上限 */
  hourlyHeadroomWalking: number;
  spentThisPlan: number;
  spentThisResolve: number;
  /** 逻辑请求与 HTTP 重试分开统计；重试同样吃小时额度 */
  logicalRequests: number;
  httpRetries: number;
}

export interface PlanState {
  planId: string;
  factsId: string;
  status: PlanStatus;
  /** 最新已提交版本；双方必须确认的就是它 */
  headRevision: number | null;
  /** 当前可正式执行的版本：只有它被双方确认且仍满足双方现行硬条件 */
  officialRevision: number | null;
  revisions: Revision[];
  attempts: Attempt[];
  conditions: { A: PartyConditions; B: PartyConditions | null };
  budget: Budget;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}

export type MeasureOutcome =
  | { ok: true; legs: Record<string, FactEntry>; retries: number }
  /** 失败时也可能带回一部分**已经付费测到**的段：钱花了就得留下，不重复烧一次 */
  | { ok: false; error: string; retries: number; simulated: boolean; legs?: Record<string, FactEntry> };

export type MeasureFn = (edges: MissingEdge[], facts: FactSet) => Promise<MeasureOutcome>;

export type ResultCode =
  | "ok"
  | "stale-revision"
  | "quota"
  | "cost-approval-needed"
  | "measurement-failed"
  | "no-solution"
  | "not-confirmable"
  | "plan-dead"
  /** 内存里改了但快照没写成功：不能对用户宣称已保存 */
  | "persist-failed"
  | "idempotent-replay";

export interface MutationResult {
  code: ResultCode;
  message: string;
  revision: Revision | null;
  solve: JointSolve | null;
  diff: NegotiationDiff | null;
  missingEdges: MissingEdge[];
}

const PLAN_TTL_MS = 72 * 60 * 60 * 1000;

function canonicalParts(itinerary: VerifiedItinerary, factsId: string, a: PartyConditions, b: PartyConditions | null): string {
  const hard = (party: PartyConditions) =>
    `${party.role}:${party.hard.maxWalkMeters ?? "∞"}|${party.hard.latestEndMinutes ?? "∞"}|↓${[...party.hard.mustVisit].sort().join(",")}|✗${[...party.hard.neverAccept].sort().join(",")}`;
  const legs = itinerary.legs.map((leg) => `${leg.fromName}>${leg.toName}:${leg.distanceMeters}m/${leg.durationMinutes}min`).join(";");
  return [
    `parties:${a.role}${b ? `,${b.role}` : ""}`,
    factsId,
    itinerary.stops.map((stop) => stop.flyaiId).join(","),
    legs,
    hard(a),
    hard(b ?? a),
    itinerary.budgetMinutes,
  ].join("::");
}

/**
 * 内容指纹：用于「双方确认的是不是同一版本」的比对，不是安全凭据。
 * 安全凭据一律走 server/plan-tickets.ts 的随机值。
 */
export function contentFingerprint(
  itinerary: VerifiedItinerary,
  factsId: string,
  a: PartyConditions,
  b: PartyConditions | null,
): string {
  const text = canonicalParts(itinerary, factsId, a, b);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const c = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x811c9dc5) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}${(text.length ^ h1).toString(16)}`;
}

export function createPlan(planId: string, facts: FactSet, a: PartyConditions, now: Date): PlanState {
  return {
    planId,
    factsId: facts.factsId,
    status: "negotiating",
    headRevision: null,
    officialRevision: null,
    revisions: [],
    attempts: [],
    conditions: { A: a, B: null },
    budget: {
      perResolveHardMax: HARD_CAP_PER_RESOLVE,
      perPlanHardMax: HARD_CAP_PER_PLAN,
      approvalThreshold: APPROVAL_THRESHOLD,
      hourlyHeadroomWalking: 80,
      spentThisPlan: 0,
      spentThisResolve: 0,
      logicalRequests: 0,
      httpRetries: 0,
    },
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    revoked: false,
  };
}

function findRevision(state: PlanState, revision: number): Revision | undefined {
  return state.revisions.find((item) => item.revision === revision);
}

export function headRevisionOf(state: PlanState): Revision | null {
  return state.headRevision === null ? null : findRevision(state, state.headRevision) ?? null;
}

export function officialRevisionOf(state: PlanState): Revision | null {
  return state.officialRevision === null ? null : findRevision(state, state.officialRevision) ?? null;
}

function deadPlanCheck(state: PlanState, now: Date): string | null {
  if (state.revoked) return "方案已被撤销，两个角色链接都立即失效。";
  if (new Date(state.expiresAt).getTime() <= now.getTime()) return "方案已过期（72 小时），请重新发起。";
  return null;
}

function requiredIds(state: PlanState): string[] {
  const parties = [state.conditions.A, state.conditions.B].filter(Boolean) as PartyConditions[];
  const ids = new Set<string>(parties.flatMap((party) => party.hard.mustVisit));
  // 强偏好也要进池：否则「特别想去」会因为不在最近 6 个之内而静默消失
  for (const party of parties) {
    for (const [id, rank] of Object.entries(party.soft)) if (rank === "prefer") ids.add(id);
  }
  return [...ids];
}

function reject(
  state: PlanState,
  attempt: Attempt,
  code: ResultCode,
  message: string,
  over: Partial<MutationResult> = {},
): MutationResult {
  state.attempts.push(attempt);
  return { code, message, revision: null, solve: null, diff: null, missingEdges: attempt.missingEdges, ...over };
}

function commitRevision(
  state: PlanState,
  facts: FactSet,
  solve: JointSolve,
  kind: "proposal" | "committed",
  role: Role,
  now: Date,
): Revision {
  const previous = headRevisionOf(state);
  const itinerary = solve.best!;
  const revisionNumber = (state.headRevision ?? 0) + 1;
  const contentHash = contentFingerprint(itinerary, facts.factsId, state.conditions.A, state.conditions.B);
  const revision: Revision = {
    revision: revisionNumber,
    contentHash,
    kind,
    itinerary,
    solve,
    diff: previous
      ? diffItineraries(previous.itinerary, itinerary, {
          fromRevision: previous.revision,
          toRevision: revisionNumber,
          fromHash: previous.contentHash,
          toHash: contentHash,
        })
      : null,
    conditionsSnapshot: { A: state.conditions.A, B: state.conditions.B },
    createdAt: now.toISOString(),
    confirmations: { A: null, B: null },
    // 内容与历史某版相同（例如退回旧走法）：号是新的，旧版确认不会挪过来
    status: state.revisions.some((item) => item.contentHash === contentHash) ? "rolled-back-content" : "pending-review",
    suspended: null,
  };
  if (previous && kind === "committed") {
    // 条件变更后的新版本：旧版本的确认不再是「当前版本的确认」，记录原因但不删记录。
    // 提案不改条件，正式执行的仍是上一份双方确认过的版本，所以这里不动它。
    previous.status = "superseded";
    previous.suspended = {
      at: now.toISOString(),
      reason: `${role} 的硬条件更新生成 v${revisionNumber}，本版本的确认随之挂起`,
    };
  }
  state.revisions.push(revision);
  state.headRevision = revisionNumber;
  state.status = "awaiting-confirmation";
  if (kind === "committed") state.officialRevision = null;
  return revision;
}

/**
 * 明确更新自己的硬条件。
 * 顺序是刻意的：**先落条件并挂起旧确认，再补测求解**——
 * B 把步行上限降到 6 公里这个动作，不会因为一次高德失败而被回退。
 */
export async function submitConditions(
  state: PlanState,
  facts: FactSet,
  input: {
    role: Role;
    conditions: PartyConditions;
    expectedRevision: number | null;
    attemptId: string;
    confirmCost?: boolean;
    now: Date;
    measure: MeasureFn;
  },
): Promise<MutationResult> {
  const replay = state.attempts.find((item) => item.attemptId === input.attemptId);
  if (replay) {
    return {
      code: "idempotent-replay",
      message: `该操作已执行过（${replay.status}），未重复消耗额度。`,
      revision: headRevisionOf(state),
      solve: headRevisionOf(state)?.solve ?? null,
      diff: headRevisionOf(state)?.diff ?? null,
      missingEdges: replay.missingEdges,
    };
  }

  const dead = deadPlanCheck(state, input.now);
  if (dead) {
    return reject(state, {
      attemptId: input.attemptId, role: input.role, kind: "update-conditions",
      status: "rejected:plan-dead", detail: dead, legsSpent: 0, missingEdges: [], simulated: false, createdAt: input.now.toISOString(),
    }, "plan-dead", dead);
  }

  if (input.expectedRevision !== state.headRevision) {
    return reject(state, {
      attemptId: input.attemptId, role: input.role, kind: "update-conditions",
      status: "rejected:stale-revision",
      detail: `提交基于 v${input.expectedRevision ?? "无"},当前已是 v${state.headRevision ?? "无"}；过期页面不能覆盖新版本。`,
      legsSpent: 0, missingEdges: [], simulated: false, createdAt: input.now.toISOString(),
    }, "stale-revision", `版本已更新，请刷新后重试（当前 v${state.headRevision ?? "无"}）。`);
  }

  // ── 花钱之前，先把条件与状态落定 ────────────────────────────────
  const previous = headRevisionOf(state);
  const supersededBy = `${input.role} 更新了硬条件`;
  state.conditions[input.role] = input.conditions;
  state.status = "paused";
  if (previous) {
    previous.status = "superseded";
    previous.suspended = { at: input.now.toISOString(), reason: `${supersededBy}，本版本的确认已挂起，旧方案不得继续执行` };
  }
  state.officialRevision = null;
  state.budget.spentThisResolve = 0;

  const targets = requiredIds(state).filter((id) => facts.pool.some((item) => item.id === id));
  const universe = facts.pool
    .filter((item) => ![state.conditions.A, state.conditions.B]
      .filter(Boolean)
      .some((party) => (party as PartyConditions).hard.neverAccept.includes(item.id)))
    .map((item) => item.id);
  const missing = estimateMissingEdges(facts, targets, { universe });

  const hardRemainingResolve = state.budget.perResolveHardMax - state.budget.spentThisResolve;
  const hardRemainingPlan = state.budget.perPlanHardMax - state.budget.spentThisPlan;
  const overQuota = Math.max(hardRemainingResolve, 0) < missing.length
    || Math.max(hardRemainingPlan, 0) < missing.length
    || state.budget.hourlyHeadroomWalking < missing.length;
  if (overQuota) {
    return reject(state, {
      attemptId: input.attemptId, role: input.role, kind: "update-conditions",
      status: "rejected:quota",
      detail: `还需实测 ${missing.length} 条有向段，单轮剩余额度 ${Math.max(hardRemainingResolve, 0)}、本方案剩余额度 ${Math.max(hardRemainingPlan, 0)}、本小时余量 ${state.budget.hourlyHeadroomWalking}。`,
      legsSpent: 0, missingEdges: missing, simulated: false, createdAt: input.now.toISOString(),
    }, "quota",
      `额度不足：本方案缺 ${missing.length} 条实测段（${missing.map((edge) => edge.name).join("、")}）。` +
      `条件已记下，方案保持待协商；这里不建议撤销重建来重置计数。`);
  }

  if (missing.length > state.budget.approvalThreshold && !input.confirmCost) {
    state.status = "awaiting-cost-approval";
    const attempt: Attempt = {
      attemptId: input.attemptId, role: input.role, kind: "update-conditions",
      status: "awaiting-cost-approval",
      detail: `本次需新增 ${missing.length} 次高德步行实测，超过建议支出阈值 ${state.budget.approvalThreshold}，等待发起方批准。`,
      legsSpent: 0, missingEdges: missing, simulated: false, createdAt: input.now.toISOString(),
    };
    state.attempts.push(attempt);
    return {
      code: "cost-approval-needed",
      message: attempt.detail,
      revision: null,
      solve: null,
      diff: null,
      missingEdges: missing,
    };
  }

  if (missing.length) {
    const outcome = await input.measure(missing, facts);
    state.budget.spentThisResolve += missing.length;
    state.budget.spentThisPlan += missing.length;
    state.budget.logicalRequests += missing.length;
    state.budget.httpRetries += outcome.retries;
    if (!outcome.ok) {
      for (const [key, entry] of Object.entries(outcome.legs ?? {})) facts.legs[key] = entry;
      const kept = Object.keys(outcome.legs ?? {}).length;
      return reject(state, {
        attemptId: input.attemptId, role: input.role, kind: "update-conditions",
        status: "rejected:measurement-failed",
        detail: `高德补测失败：${outcome.error}。${outcome.simulated ? "（夹具注入的模拟失败，非真实返回）" : ""}` +
          (kept ? ` 已付费测到的 ${kept} 条段已留在事实层，不会重复消耗。` : ""),
        legsSpent: missing.length, missingEdges: missing, simulated: outcome.simulated, createdAt: input.now.toISOString(),
      }, "measurement-failed",
        `新条件已记下，旧方案的确认保持挂起；补测失败不会让超限的旧路线重新可用。`,
        { missingEdges: missing });
    }
    for (const [key, entry] of Object.entries(outcome.legs)) facts.legs[key] = entry;
  }

  const solve = solveJoint(facts, state.conditions.A, state.conditions.B, input.now);
  if (!solve.best) {
    const status: AttemptStatus =
      solve.kind === "hard-conflict" ? "rejected:hard-conflict"
        : solve.kind === "not-measured" ? "rejected:not-measured"
          : "rejected:constraint-invalid";
    return reject(state, {
      attemptId: input.attemptId, role: input.role, kind: "update-conditions",
      status, detail: solve.note, legsSpent: missing.length, missingEdges: solve.missingEdges,
      simulated: false, createdAt: input.now.toISOString(),
    }, "no-solution", solve.note, { solve, missingEdges: solve.missingEdges });
  }

  const revision = commitRevision(state, facts, solve, "committed", input.role, input.now);
  state.attempts.push({
    attemptId: input.attemptId, role: input.role, kind: "update-conditions",
    status: "succeeded", detail: `v${revision.revision} 已提交，等待双方确认同一版本。`,
    legsSpent: missing.length, missingEdges: solve.missingEdges, simulated: false, createdAt: input.now.toISOString(),
  });
  return { code: "ok", message: `v${revision.revision} 已生成，等待 A、B 分别确认。`, revision, solve, diff: revision.diff, missingEdges: solve.missingEdges };
}

/**
 * 「少走一点」这类**不改变条件**的提案：失败时原有确认一律保留，
 * 成功时也只是多一个待确认版本，正式执行的仍是上一份双方确认过的方案。
 */
export async function proposeRoute(
  state: PlanState,
  facts: FactSet,
  input: {
    role: Role;
    expectedRevision: number | null;
    attemptId: string;
    now: Date;
    measure: MeasureFn;
  },
): Promise<MutationResult> {
  const replay = state.attempts.find((item) => item.attemptId === input.attemptId);
  if (replay) {
    return { code: "idempotent-replay", message: "该提案已提交过，未重复消耗额度。", revision: headRevisionOf(state), solve: headRevisionOf(state)?.solve ?? null, diff: headRevisionOf(state)?.diff ?? null, missingEdges: replay.missingEdges };
  }
  const dead = deadPlanCheck(state, input.now);
  if (dead) {
    return reject(state, { attemptId: input.attemptId, role: input.role, kind: "propose-route", status: "rejected:plan-dead", detail: dead, legsSpent: 0, missingEdges: [], simulated: false, createdAt: input.now.toISOString() }, "plan-dead", dead);
  }
  if (input.expectedRevision !== state.headRevision) {
    return reject(state, { attemptId: input.attemptId, role: input.role, kind: "propose-route", status: "rejected:stale-revision", detail: "提案基于过期版本。", legsSpent: 0, missingEdges: [], simulated: false, createdAt: input.now.toISOString() }, "stale-revision", "版本已更新，请刷新后重试。");
  }

  const solve = solveJoint(facts, state.conditions.A, state.conditions.B, input.now);
  if (!solve.best) {
    return reject(state, {
      attemptId: input.attemptId, role: input.role, kind: "propose-route",
      status: solve.kind === "not-measured" ? "rejected:not-measured" : "rejected:hard-conflict",
      detail: solve.note, legsSpent: 0, missingEdges: solve.missingEdges, simulated: false, createdAt: input.now.toISOString(),
    }, "no-solution", solve.note, { solve });
  }

  const revision = commitRevision(state, facts, solve, "proposal", input.role, input.now);
  state.attempts.push({
    attemptId: input.attemptId, role: input.role, kind: "propose-route",
    status: "succeeded", detail: `v${revision.revision} 提案已生成，需双方确认才会成为正式方案。`,
    legsSpent: 0, missingEdges: [], simulated: false, createdAt: input.now.toISOString(),
  });
  return { code: "ok", message: `v${revision.revision} 提案已生成，正式执行的仍是上一份双方确认过的版本。`, revision, solve, diff: revision.diff, missingEdges: [] };
}

/** 确认。待协商 / 求解中 / 失败态下不允许确认，确认永不产生新版本。 */
export function confirmRevision(
  state: PlanState,
  input: { role: Role; revision: number; contentHash: string; now: Date },
): MutationResult {
  const dead = deadPlanCheck(state, input.now);
  if (dead) {
    return reject(state, { attemptId: `confirm:${input.role}:${Date.now()}`, role: input.role, kind: "confirm", status: "rejected:plan-dead", detail: dead, legsSpent: 0, missingEdges: [], simulated: false, createdAt: input.now.toISOString() }, "plan-dead", dead);
  }
  const attemptId = `confirm:${input.role}:${input.revision}:${input.contentHash}`;
  const target = findRevision(state, input.revision);
  if (!target || input.revision !== state.headRevision) {
    return reject(state, { attemptId, role: input.role, kind: "confirm", status: "rejected:not-confirmable", detail: `只能确认当前版本 v${state.headRevision ?? "无"}，收到的是 v${input.revision}。`, legsSpent: 0, missingEdges: [], simulated: false, createdAt: input.now.toISOString() },
      "not-confirmable", `当前版本是 v${state.headRevision ?? "无"}，v${input.revision} 已不是最新方案。`);
  }
  if (state.status === "paused" || state.status === "awaiting-cost-approval") {
    return reject(state, { attemptId, role: input.role, kind: "confirm", status: "rejected:not-confirmable", detail: `方案处于${state.status === "paused" ? "待协商" : "待成本批准"}状态，没有可确认的版本。`, legsSpent: 0, missingEdges: [], simulated: false, createdAt: input.now.toISOString() },
      "not-confirmable", "待协商或待成本批准时不能确认，也不能执行。");
  }
  if (target.contentHash !== input.contentHash) {
    return reject(state, { attemptId, role: input.role, kind: "confirm", status: "rejected:not-confirmable", detail: "确认的内容指纹与当前版本不一致。", legsSpent: 0, missingEdges: [], simulated: false, createdAt: input.now.toISOString() },
      "not-confirmable", "你看到的版本已经变了，请刷新后重新确认。");
  }

  target.confirmations[input.role] = { contentHash: input.contentHash, at: input.now.toISOString() };
  const other: Role = input.role === "A" ? "B" : "A";
  const peer = target.confirmations[other];
  const singleParty = state.conditions.B === null;

  if (peer && peer.contentHash === input.contentHash) {
    target.status = "jointly-confirmed";
    state.officialRevision = target.revision;
    state.status = "jointly-confirmed";
    // 双方确认了这份，其它版本一律记为已被取代（确认记录留在各自版本上，不删除）
    for (const other of state.revisions) {
      if (other.revision === target.revision) continue;
      if (other.status === "superseded") continue;
      other.status = "superseded";
      other.suspended = { at: input.now.toISOString(), reason: `A、B 已共同确认 v${target.revision}` };
    }
    return { code: "ok", message: `A、B 已确认同一个 v${target.revision}，方案正式生效。`, revision: target, solve: target.solve, diff: target.diff, missingEdges: [] };
  }
  if (singleParty && input.role === "A") {
    // B 还没表态：不能算双方确认
    target.status = "confirmed-one";
    state.status = "awaiting-confirmation";
    return { code: "ok", message: "已记录 A 的确认，等待 B 确认同一版本。", revision: target, solve: target.solve, diff: target.diff, missingEdges: [] };
  }
  target.status = "confirmed-one";
  state.status = "awaiting-confirmation";
  return { code: "ok", message: `已记录 ${input.role} 的确认，等待 ${other} 确认 v${target.revision}。`, revision: target, solve: target.solve, diff: target.diff, missingEdges: [] };
}

/**
 * 执行门禁。只有同时满足：存在官方版本 ∧ 该版本双方确认同一内容 ∧ 事实核验完成
 * ∧ 仍满足双方**现行**硬条件，才允许正式执行；且只读这份版本，绝不回退到城市/类别路线。
 */
export function canExecute(state: PlanState, now: Date): { allowed: boolean; reason: string } {
  const dead = deadPlanCheck(state, now);
  if (dead) return { allowed: false, reason: dead };
  const official = officialRevisionOf(state);
  if (!official) {
    return { allowed: false, reason: state.status === "paused"
      ? "有硬性条件更新后旧方案已被挂起，双方确认新版本之前不得正式执行。"
      : "还没有双方确认过的版本。" };
  }
  if (official.status !== "jointly-confirmed") {
    return { allowed: false, reason: `v${official.revision} 的确认状态是 ${official.status}，不是双方确认。` };
  }
  // 更新的提案可以悬在头上等待确认，但它不会自动替换正式执行的版本
  for (const stop of official.itinerary.stops) {
    if (stop.matchStatus === "unverified") {
      return { allowed: false, reason: `「${stop.name}」的高德身份核验未通过，正式执行不能带着未核实的地点。` };
    }
    if (stop.openingStatus === "conflict") {
      return { allowed: false, reason: `「${stop.name}」在假定时间窗口内确认不开放（${stop.openingNote}），需双方重新协商。` };
    }
  }
  const a = state.conditions.A;
  const b = state.conditions.B;
  for (const party of [a, b].filter(Boolean) as PartyConditions[]) {
    const meters = official.itinerary.totalWalkMeters;
    if (party.hard.maxWalkMeters !== null && meters > party.hard.maxWalkMeters) {
      return { allowed: false, reason: `v${official.revision} 步行 ${meters} 米，已违反 ${party.role} 现行上限 ${party.hard.maxWalkMeters} 米。` };
    }
    for (const id of party.hard.mustVisit) {
      if (!official.itinerary.stops.some((stop) => stop.flyaiId === id)) {
        return { allowed: false, reason: `v${official.revision} 缺少 ${party.role} 的必须去站点 ${id}。` };
      }
    }
    for (const id of party.hard.neverAccept) {
      if (official.itinerary.stops.some((stop) => stop.flyaiId === id)) {
        return { allowed: false, reason: `v${official.revision} 含 ${party.role} 绝不接受的站点 ${id}。` };
      }
    }
  }
  return { allowed: true, reason: `v${official.revision} 已双方确认、事实核验完成且满足双方现行硬条件。` };
}

/** 双人执行只认这份返回值；为 null 时界面必须显示待协商，不许拿旧城市/类别路线顶上。 */
export function executionRoute(state: PlanState, now: Date): VerifiedItinerary | null {
  const gate = canExecute(state, now);
  if (!gate.allowed) return null;
  return officialRevisionOf(state)?.itinerary ?? null;
}
