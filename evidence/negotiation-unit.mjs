import { haversineMeters } from "../src/lib/geo.ts";
import {
  APPROVAL_THRESHOLD,
  HARD_CAP_PER_PLAN,
  HARD_CAP_PER_RESOLVE,
  confirmRevision,
  contentFingerprint,
  canExecute,
  createPlan,
  executionRoute,
  headRevisionOf,
  officialRevisionOf,
  proposeRoute,
  submitConditions,
} from "../src/lib/negotiation/plan-state.ts";
import { diffItineraries } from "../src/lib/negotiation/diff.ts";
import { estimateMissingEdges, solveJoint } from "../src/lib/negotiation/solve.ts";
import {
  makeCompleteFacts,
  makeShortlistedFacts,
} from "./negotiation-fixture.ts";
import { sanitizeConditions } from "../src/lib/plan-api.ts";
import {
  agentScopeKey,
  agentTurnKey,
  credentialMatches,
  hashCredential,
  mintPlanId,
  mintRoleToken,
} from "../src/lib/server/plan-tickets.ts";

/**
 * 夹具单元测试：零高德、零飞猪、零百炼调用。
 * 这里的数字全部来自 negotiation-fixture.ts 的模拟数据，通过不代表任何真实能力；
 * 真实路线仍由 evidence/phase6-accept.mjs 与 evidence/phase8-accept.mjs 实测验收。
 */

const START_AT = new Date("2026-10-21T13:00:00");
const results = [];
function check(name, pass, extra) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
}

function cond(role, over = {}) {
  return {
    role,
    hard: { latestEndMinutes: null, maxWalkMeters: null, mustVisit: [], neverAccept: [], ...(over.hard ?? {}) },
    soft: over.soft ?? {},
    bias: over.bias ?? "neutral",
  };
}

const nameOf = (facts, id) => (id === "__start__" ? facts.start.name : facts.pool.find((item) => item.id === id)?.name ?? id);
const posOf = (facts, id) => (id === "__start__" ? facts.start.position : facts.pool.find((item) => item.id === id)?.position);

/** 夹具注入的「补测成功」：明确标注是模拟段，不是高德返回。 */
function synthLegs(facts, edges, fromCache = false) {
  const legs = {};
  for (const edge of edges) {
    const [fromId, toId] = edge.key.split("->");
    const minutes = Math.max(1, Math.round(haversineMeters(posOf(facts, fromId), posOf(facts, toId)) / 80));
    legs[edge.key] = {
      measuredAt: new Date().toISOString(),
      leg: {
        fromName: nameOf(facts, fromId),
        toName: nameOf(facts, toId),
        from: posOf(facts, fromId),
        to: posOf(facts, toId),
        distanceMeters: minutes * 80,
        durationMinutes: minutes,
        durationSeconds: minutes * 60,
        stepCount: 0,
        firstInstruction: null,
        polyline: [],
        fromCache,
      },
    };
  }
  return legs;
}

function makeMeasure({ fail = false, retries = 0 } = {}) {
  const calls = [];
  return {
    calls,
    measure: async (edges) => {
      calls.push(edges.map((edge) => edge.key));
      if (fail) {
        return { ok: false, error: "高德 direction/walking 无返回（夹具注入）", retries, simulated: true };
      }
      return { ok: true, legs: synthLegs(usableFacts, edges), retries };
    },
  };
}
let usableFacts = makeCompleteFacts();

/* ── 求解与差异 ─────────────────────────────────────────────────── */
const facts = makeCompleteFacts();
const baseline = solveJoint(facts, cond("A"), null, START_AT);
check("S1 单人无附加条件时双人求解给出最长可行组合", baseline.kind === "found" && baseline.best.stops.length === 4, {
  kind: baseline.kind, stops: baseline.best.stops.map((s) => s.name), meters: baseline.best.totalWalkMeters, minutes: baseline.best.totalMinutes,
});

const capped = solveJoint(facts, cond("A"), cond("B", { hard: { maxWalkMeters: 2000 } }), START_AT);
const downDiff = diffItineraries(baseline.best, capped.best, { fromRevision: 1, toRevision: 2, fromHash: "h1", toHash: "h2" });
check("S2 收紧步行上限后差异保留负号", downDiff.totalWalkMeters.delta === capped.best.totalWalkMeters - baseline.best.totalWalkMeters && downDiff.totalWalkMeters.direction === "decrease", {
  from: baseline.best.totalWalkMeters, to: capped.best.totalWalkMeters, delta: downDiff.totalWalkMeters.delta,
});
check("S2b 差异文案使用「少走」而不是绝对值掩盖", downDiff.lines[0].includes("少走"), { line: downDiff.lines[0] });

const added = solveJoint(facts, cond("A", { hard: { mustVisit: ["c5"] } }), null, START_AT);
const upDiff = diffItineraries(baseline.best, added.best, { fromRevision: 1, toRevision: 2, fromHash: "h1", toHash: "h2" });
check("S3 加入更远的必须去后差异保留正号（不钳位成 0）", upDiff.totalWalkMeters.delta > 0 && upDiff.lines[0].includes("多走"), {
  delta: upDiff.totalWalkMeters.delta, line: upDiff.lines[0],
});
check("S3b 必须去真正进入方案", added.best.stops.some((stop) => stop.flyaiId === "c5"), { stops: added.best.stops.map((s) => s.name) });

const conflict = solveJoint(facts, cond("A"), cond("B", { hard: { maxWalkMeters: 1000, mustVisit: ["c4"] } }), START_AT);
check("S4 全部相关段已实测时才允许「已证实不可行」", conflict.kind === "hard-conflict" && conflict.best === null, {
  kind: conflict.kind, evidence: conflict.hardConflict?.evidence,
});
check("S4b 不可行结论带实测数字证据", /公里|米/.test(conflict.hardConflict.evidence.join("")) && conflict.hardConflict.evidence.join("").includes("比本方上限"), {
  evidence: conflict.hardConflict.evidence,
});

const farFacts = makeShortlistedFacts();
const farUniverse = farFacts.pool.map((item) => item.id);
const unmeasured = solveJoint(farFacts, cond("A"), cond("B", { hard: { mustVisit: ["s7", "s8"] } }), START_AT);
const quoted = estimateMissingEdges(farFacts, ["s7", "s8"], { universe: farUniverse });
check("S5 缺实测段时只说「尚未核验」，不宣称不可行", unmeasured.kind === "not-measured" && unmeasured.best === null, { kind: unmeasured.kind });
check("S5b 补测报价等于去重后的实际缺边（与状态机同一口径）", unmeasured.extraLegsNeeded === quoted.length && quoted.length > 0 && new Set(quoted.map((edge) => edge.key)).size === quoted.length, {
  needed: unmeasured.extraLegsNeeded, keys: quoted.map((edge) => edge.key),
});
check("S5c 单站补测不超过每站 9 段上界", estimateMissingEdges(farFacts, ["s7"], { universe: farUniverse }).length <= HARD_CAP_PER_RESOLVE, {
  one: estimateMissingEdges(farFacts, ["s7"], { universe: farUniverse }).length,
});
check("S5d 起点→断桥残雪 这类「高德明确无路线」不计入待补测", !unmeasured.missingEdges.some((edge) => edge.key === "__start__->c4"), {
  missing: unmeasured.missingEdges.map((edge) => edge.key),
});
const s7Disposition = unmeasured.dispositions.find((item) => item.id === "s7");
check("S5e 短名单外的候选被标为尚未核验而不是「已排除」", s7Disposition?.status === "not-measured" && s7Disposition.text.includes("不是「不去」"), s7Disposition);
const singleFar = solveJoint(farFacts, cond("A"), cond("B", { hard: { mustVisit: ["s7"] } }), START_AT);
check("S5f 能实测出的方案照给，但同时说明搜索空间被缺边截断", singleFar.kind === "found" && singleFar.best.stops.some((stop) => stop.flyaiId === "s7") && singleFar.note.includes("已实测范围内的最优"), {
  stops: singleFar.best.stops.map((stop) => stop.name), quote: singleFar.extraLegsNeeded,
});

const softFacts = makeShortlistedFacts();
const imbalanced = solveJoint(softFacts, cond("A", { soft: { c1: "prefer" } }), cond("B", { soft: { s7: "prefer" } }), START_AT);
check("S6 一方强偏好全落空时仍出方案，并标为需双方协商（软偏好）", imbalanced.kind === "soft-imbalanced" && imbalanced.best !== null, {
  kind: imbalanced.kind, note: imbalanced.note.slice(0, 40),
});
check("S6b 落空的是无法满足的那一方（B），且没有为了「差距为零」把 A 的也扔掉", imbalanced.unmet.some((item) => item.role === "B" && item.text.includes("特别想去")) && imbalanced.best.stops.some((stop) => stop.flyaiId === "c1"), {
  unmet: imbalanced.unmet.filter((item) => item.role === "B"), stops: imbalanced.best.stops.map((stop) => stop.name),
});
check("S6c 软偏好落空写清角色且不写成硬冲突", imbalanced.note.includes("软偏好，不是硬约束冲突"), { note: imbalanced.note.slice(-60) });

const followOnly = solveJoint(facts, cond("A", { soft: { c1: "prefer" } }), cond("B", { soft: { c1: "follow", c5: "follow" } }), START_AT);
check("S7 愿意跟随既不计满足度也不记落空", !followOnly.satisfied.some((item) => item.role === "B") && !followOnly.unmet.some((item) => item.role === "B") && followOnly.kind === "found", {
  b: followOnly.satisfied.filter((item) => item.role === "B").concat(followOnly.unmet.filter((item) => item.role === "B")),
});

const avoidCase = solveJoint(facts, cond("A", { bias: "see_more" }), cond("B", { soft: { c2: "avoid" }, bias: "walk_less" }), START_AT);
const avoidHit = avoidCase.satisfied.concat(avoidCase.unmet).find((item) => item.text.includes("不太想去"));
check("S8 不太想去只是扣分，不等同于绝不接受", avoidCase.best !== null && Boolean(avoidHit) && avoidHit.text.includes("不等于绝不接受"), avoidHit);

const preferDropped = solveJoint(facts, cond("A"), cond("B", { hard: { maxWalkMeters: 1000 }, soft: { c4: "prefer" } }), START_AT);
check("S9 特别想去可以被舍弃（与必须去区分开）", preferDropped.kind === "hard-conflict" || preferDropped.unmet.some((item) => item.kind === "soft"), {
  kind: preferDropped.kind,
});

const allDropped = solveJoint(facts, cond("A", { hard: { neverAccept: ["c1", "c2", "c3"] } }), null, START_AT);
check("S10 双人允许 1~2 站", allDropped.best.stops.length <= 2 && allDropped.best.stops.length >= 1, { stops: allDropped.best.stops.map((s) => s.name) });

const wording = [baseline, capped, added, imbalanced, unmeasured].flatMap((solve) => solve.dispositions ?? []);
check("S11「已排除」只用于绝不接受，不用于软偏好落空", wording.every((item) => !item.text.includes("已排除") || item.status === "rejected-never"), {
  offenders: wording.filter((item) => item.text.includes("已排除") && item.status !== "rejected-never"),
});
const notice = [baseline.note, capped.note].join("");
check("S12 成本口径四项标注（不含回程/站内/模拟停留/不含门票）+ 开放时间非保证", ["不含回程", "景区内部的步行量", "模拟值", "没有任何来自数据的门票", "不是完整开放时间的保证"].every((text) => notice.includes(text)));

const hashA = contentFingerprint(baseline.best, facts.factsId, cond("A"), null);
const hashB = contentFingerprint(baseline.best, facts.factsId, cond("A"), null);
const mutated = structuredClone(facts);
mutated.legs["__start__->c1"].leg.distanceMeters += 80;
const solveMutated = solveJoint(mutated, cond("A"), null, START_AT);
const hashMutated = contentFingerprint(solveMutated.best, facts.factsId, cond("A"), null);
const reorderByCondition = solveJoint(facts, cond("A", { hard: { maxWalkMeters: 1700 } }), null, START_AT);
check("S13 版本指纹覆盖段实测值与站点顺序", hashA === hashB && hashMutated !== hashA && contentFingerprint(reorderByCondition.best, facts.factsId, cond("A"), null) !== hashA, {
  hashA, hashMutated,
});
check("S14 版本指纹覆盖双方硬条件", contentFingerprint(baseline.best, facts.factsId, cond("A"), cond("B")) !== contentFingerprint(baseline.best, facts.factsId, cond("A"), null));

/* ── 门 1：条件更新后异步补测失败，旧确认必须保持挂起 ─────────────── */
usableFacts = makeShortlistedFacts();
const g1facts = usableFacts;
const plan1 = createPlan(mintPlanId(), g1facts, cond("A"), START_AT);
await submitConditions(plan1, g1facts, { role: "A", conditions: cond("A"), expectedRevision: null, attemptId: "a1", now: START_AT, measure: makeMeasure().measure });
const m2 = makeMeasure();
await submitConditions(plan1, g1facts, { role: "B", conditions: cond("B"), expectedRevision: 1, attemptId: "b1", now: START_AT, measure: m2.measure });
const v2 = headRevisionOf(plan1);
confirmRevision(plan1, { role: "A", revision: v2.revision, contentHash: v2.contentHash, now: START_AT });
confirmRevision(plan1, { role: "B", revision: v2.revision, contentHash: v2.contentHash, now: START_AT });
check("G1-pre 双方确认同一版本后可正式执行", canExecute(plan1, START_AT).allowed && officialRevisionOf(plan1)?.revision === v2.revision, canExecute(plan1, START_AT));

const failing = makeMeasure({ fail: true, retries: 2 });
const before = { head: plan1.headRevision, revisions: plan1.revisions.length, spent: plan1.budget.spentThisPlan };
const g1 = await submitConditions(plan1, g1facts, {
  role: "B",
  conditions: cond("B", { hard: { mustVisit: ["s7"], maxWalkMeters: 3000 } }),
  expectedRevision: v2.revision,
  attemptId: "b2",
  confirmCost: true,
  now: START_AT,
  measure: failing.measure,
});
const attempt = plan1.attempts.at(-1);
check("门1 硬条件先落定：失败后 B 的要求仍然生效", g1.code === "measurement-failed" && plan1.conditions.B.hard.mustVisit.includes("s7"), { code: g1.code });
check("门1 补测失败后旧确认仍保持挂起、不复活", plan1.status === "paused" && v2.suspended !== null && officialRevisionOf(plan1) === null, {
  status: plan1.status, official: plan1.officialRevision,
});
check("门1 超限的旧方案被禁止执行", !canExecute(plan1, START_AT).allowed && executionRoute(plan1, START_AT) === null && canExecute(plan1, START_AT).reason.includes("挂起"), canExecute(plan1, START_AT));
check("门1 失败不产生新版本", plan1.headRevision === before.head && plan1.revisions.length === before.revisions, { head: plan1.headRevision });
check("门1 失败尝试在双方可见且标注为模拟失败", attempt.status === "rejected:measurement-failed" && attempt.simulated === true && attempt.detail.includes("模拟失败"), attempt.detail);
check("门1 已消耗额度如实记账，逻辑请求与重试分开", plan1.budget.spentThisPlan === before.spent + failing.calls[0].length && plan1.budget.logicalRequests === failing.calls[0].length && plan1.budget.httpRetries === 2, {
  ...plan1.budget, edges: failing.calls[0]?.length,
});
const g1confirm = confirmRevision(plan1, { role: "A", revision: v2.revision, contentHash: v2.contentHash, now: START_AT });
check("门1 待协商状态下不能确认", g1confirm.code === "not-confirmable", g1confirm.message);
const replayMeasure = makeMeasure();
const replay = await submitConditions(plan1, g1facts, {
  role: "B", conditions: cond("B", { hard: { mustVisit: ["s7"], maxWalkMeters: 3000 } }),
  expectedRevision: v2.revision, attemptId: "b2", now: START_AT, measure: replayMeasure.measure,
});
check("门1 同 attemptId 重放不重复消耗额度", replay.code === "idempotent-replay" && replayMeasure.calls.length === 0 && plan1.attempts.filter((item) => item.attemptId === "b2").length === 1, {
  code: replay.code, attempts: plan1.attempts.filter((item) => item.attemptId === "b2").length,
});
const staleMeasure = makeMeasure();
const stale = await submitConditions(plan1, g1facts, {
  role: "A", conditions: cond("A", { hard: { maxWalkMeters: 900 } }), expectedRevision: 1, attemptId: "a2", now: START_AT, measure: staleMeasure.measure,
});
check("门1b 过期版本提交在花钱之前就被拒绝", stale.code === "stale-revision" && staleMeasure.calls.length === 0, { code: stale.code, head: plan1.headRevision });
check("门1c CAS 拒绝时不覆盖条件也不额外挂起确认", plan1.conditions.A.hard.maxWalkMeters === null && plan1.attempts.filter((item) => item.attemptId === "a2")[0].status === "rejected:stale-revision");

/* ── 门 2：未确认/已挂起版本无法执行；提案不自动替换正式路线 ──────── */
usableFacts = makeCompleteFacts();
const plan2 = createPlan(mintPlanId(), usableFacts, cond("A"), START_AT);
await submitConditions(plan2, usableFacts, { role: "A", conditions: cond("A"), expectedRevision: null, attemptId: "p-a1", now: START_AT, measure: makeMeasure().measure });
await submitConditions(plan2, usableFacts, { role: "B", conditions: cond("B"), expectedRevision: 1, attemptId: "p-b1", now: START_AT, measure: makeMeasure().measure });
const official2 = headRevisionOf(plan2);
confirmRevision(plan2, { role: "A", revision: official2.revision, contentHash: official2.contentHash, now: START_AT });
check("门2 单方确认不产生新版本，也不能执行", plan2.revisions.length === 2 && !canExecute(plan2, START_AT).allowed && plan2.status === "awaiting-confirmation", {
  status: plan2.status, revisions: plan2.revisions.length,
});
confirmRevision(plan2, { role: "B", revision: official2.revision, contentHash: official2.contentHash, now: START_AT });
check("门2 双方确认同一 revision 才允许正式执行", canExecute(plan2, START_AT).allowed && executionRoute(plan2, START_AT) === official2.itinerary, canExecute(plan2, START_AT));

const proposal = await proposeRoute(plan2, usableFacts, { role: "A", expectedRevision: official2.revision, attemptId: "p-prop", now: START_AT, measure: makeMeasure().measure });
check("门2b 少走一点只生成待确认提案", proposal.code === "ok" && proposal.revision.kind === "proposal" && plan2.status === "awaiting-confirmation", {
  kind: proposal.revision.kind, head: plan2.headRevision, official: plan2.officialRevision,
});
check("门2c 提案未确认前正式执行的仍是上一份双方确认过的版本", executionRoute(plan2, START_AT) === official2.itinerary && canExecute(plan2, START_AT).allowed);
const lateConfirm = confirmRevision(plan2, { role: "A", revision: official2.revision, contentHash: official2.contentHash, now: START_AT });
check("门2d 只能确认当前版本，旧版本的确认入口已关闭", lateConfirm.code === "not-confirmable", lateConfirm.message);
confirmRevision(plan2, { role: "A", revision: proposal.revision.revision, contentHash: proposal.revision.contentHash, now: START_AT });
confirmRevision(plan2, { role: "B", revision: proposal.revision.revision, contentHash: proposal.revision.contentHash, now: START_AT });
check("门2e 提案被双方确认后才替换正式路线", plan2.officialRevision === proposal.revision.revision && executionRoute(plan2, START_AT) === proposal.revision.itinerary, {
  official: plan2.officialRevision,
});
const crossRole = confirmRevision({ ...plan2, conditions: { A: cond("A"), B: cond("B") }, revisions: plan2.revisions.map((item) => ({ ...item, confirmations: { A: null, B: null } })) }, {
  role: "A", revision: plan2.headRevision, contentHash: "别人的指纹", now: START_AT,
});
check("门2f 内容指纹不符的确认被拒绝", crossRole.code === "not-confirmable", crossRole.message);
const deadPlan = { ...plan2, revoked: true };
check("门2g 已撤销的方案不能执行也不回退到城市/类别路线", !canExecute(deadPlan, START_AT).allowed && executionRoute(deadPlan, START_AT) === null, canExecute(deadPlan, START_AT));

/* ── 门 3：成本批准只越软阈值，越不过硬上限 ─────────────────────── */
usableFacts = makeShortlistedFacts();
const universeIds = usableFacts.pool.map((item) => item.id);
const oneTarget = estimateMissingEdges(usableFacts, ["s7"], { universe: universeIds }).length;
const twoTargets = estimateMissingEdges(usableFacts, ["s7", "s8"], { universe: universeIds }).length;
const plan3 = createPlan(mintPlanId(), usableFacts, cond("A"), START_AT);
await submitConditions(plan3, usableFacts, { role: "A", conditions: cond("A"), expectedRevision: null, attemptId: "c-a1", now: START_AT, measure: makeMeasure().measure });
const noApproval = makeMeasure();
const gated = await submitConditions(plan3, usableFacts, {
  role: "B", conditions: cond("B", { hard: { mustVisit: ["s7"] } }), expectedRevision: plan3.headRevision, attemptId: "c-b1", now: START_AT, measure: noApproval.measure,
});
check("门3 报价落在阈值与硬上限之间（夹具前提）", oneTarget > APPROVAL_THRESHOLD && oneTarget <= HARD_CAP_PER_RESOLVE && twoTargets > HARD_CAP_PER_RESOLVE, {
  oneTarget, twoTargets,
});
check("门3a 超过建议支出阈值时先报价再执行，未批准一分不花", gated.code === "cost-approval-needed" && noApproval.calls.length === 0 && plan3.budget.spentThisPlan === 0 && gated.missingEdges.length === oneTarget, {
  code: gated.code, need: gated.missingEdges.length,
});
check("门3a2 待成本批准时不能确认，也不能执行", confirmRevision(plan3, { role: "A", revision: plan3.headRevision, contentHash: headRevisionOf(plan3).contentHash, now: START_AT }).code === "not-confirmable" && !canExecute(plan3, START_AT).allowed);
const approved = makeMeasure({ retries: 3 });
const afterApprove = await submitConditions(plan3, usableFacts, {
  role: "B", conditions: cond("B", { hard: { mustVisit: ["s7"] } }), expectedRevision: plan3.headRevision, attemptId: "c-b2", confirmCost: true, now: START_AT, measure: approved.measure,
});
check("门3b 批准后在硬上限内才真正补测，逻辑请求与 HTTP 重试分开记账", afterApprove.code === "ok" && approved.calls.length === 1 && plan3.budget.logicalRequests === oneTarget && plan3.budget.httpRetries === 3 && plan3.budget.spentThisPlan === oneTarget, {
  code: afterApprove.code, logical: plan3.budget.logicalRequests, retries: plan3.budget.httpRetries,
});
check("门3b2 补测之后必须去真的进了新方案", afterApprove.revision.itinerary.stops.some((stop) => stop.flyaiId === "s7"), {
  stops: afterApprove.revision.itinerary.stops.map((stop) => stop.name),
});
usableFacts = makeShortlistedFacts();
const plan5 = createPlan(mintPlanId(), usableFacts, cond("A"), START_AT);
await submitConditions(plan5, usableFacts, { role: "A", conditions: cond("A"), expectedRevision: null, attemptId: "c3-a1", now: START_AT, measure: makeMeasure().measure });
const overResolve = makeMeasure();
const resolveRefusal = await submitConditions(plan5, usableFacts, {
  role: "B", conditions: cond("B", { hard: { mustVisit: ["s7", "s8"] } }), expectedRevision: plan5.headRevision, attemptId: "c3-b1", confirmCost: true, now: START_AT, measure: overResolve.measure,
});
check("门3c confirmCost 越不过单轮硬上限，且在花钱之前就拒绝", resolveRefusal.code === "quota" && overResolve.calls.length === 0 && plan5.budget.spentThisPlan === 0, {
  code: resolveRefusal.code, need: twoTargets,
});
usableFacts = makeShortlistedFacts();
const plan4 = createPlan(mintPlanId(), usableFacts, cond("A"), START_AT);
await submitConditions(plan4, usableFacts, { role: "A", conditions: cond("A"), expectedRevision: null, attemptId: "c2-a1", now: START_AT, measure: makeMeasure().measure });
plan4.budget.spentThisPlan = HARD_CAP_PER_PLAN - 1;
const overspent = makeMeasure();
const hardRefusal = await submitConditions(plan4, usableFacts, {
  role: "B", conditions: cond("B", { hard: { mustVisit: ["s7"] } }), expectedRevision: plan4.headRevision, attemptId: "c2-b1", confirmCost: true, now: START_AT, measure: overspent.measure,
});
check("门3c confirmCost 越不过单方案硬上限，且一分不花", hardRefusal.code === "quota" && overspent.calls.length === 0 && plan4.budget.spentThisPlan === HARD_CAP_PER_PLAN - 1, {
  code: hardRefusal.code, spent: plan4.budget.spentThisPlan,
});
check("门3d 额度不足时留在原方案说明缺什么，不建议撤销重建重置计数", hardRefusal.message.includes("条件已记下") && hardRefusal.message.includes("不建议撤销重建"), hardRefusal.message);
check("门3e 小时余量同样是硬上限", plan4.budget.hourlyHeadroomWalking >= 0 && HARD_CAP_PER_RESOLVE === 9 && HARD_CAP_PER_PLAN === 18 && APPROVAL_THRESHOLD === 6, {
  caps: [HARD_CAP_PER_RESOLVE, HARD_CAP_PER_PLAN, APPROVAL_THRESHOLD],
});
plan4.budget.spentThisPlan = 0;
plan4.budget.hourlyHeadroomWalking = 1;
const tightHourly = makeMeasure();
const hourlyRefusal = await submitConditions(plan4, usableFacts, {
  role: "B", conditions: cond("B", { hard: { mustVisit: ["s7"] } }), expectedRevision: plan4.headRevision, attemptId: "c2-b2", confirmCost: true, now: START_AT, measure: tightHourly.measure,
});
check("门3f 本小时余量不足时直接拒绝，不退化成「先试一下」", hourlyRefusal.code === "quota" && tightHourly.calls.length === 0, hourlyRefusal.message);

/* ── 门 4：一方拿不到另一方的 Agent 上下文 ─────────────────────── */
const itineraryKey = "c1,c2,c3,c4";
check("门4 会话去重键含 planId 与角色，同源行程不再并成一个上下文", agentScopeKey("plan-x", "A", itineraryKey) !== agentScopeKey("plan-x", "B", itineraryKey) && agentScopeKey("plan-x", "A", itineraryKey) !== itineraryKey);
check("门4b 回合去重键含角色，同一秒同一意图不会互串结果", agentTurnKey("plan-x", "A", "explore", "t", "c1") !== agentTurnKey("plan-x", "B", "explore", "t", "c1"));
const goodTokenForGate4 = mintRoleToken();
check("门4c 作用域键不是凭据：由公开字段拼出来的 planId|role|行程 冒充角色令牌一定被拒",
  credentialMatches(agentScopeKey("plan-x", "A", itineraryKey), hashCredential(goodTokenForGate4)) === false &&
    credentialMatches(agentScopeKey("plan-x", "B", itineraryKey), hashCredential(goodTokenForGate4)) === false);
check("门4d 角色令牌高熵、服务端只存哈希、比对可用 timingSafeEqual", mintRoleToken().length >= 32 && mintRoleToken() !== mintRoleToken() && credentialMatches(mintPlanId(), hashCredential("x")) === false);
const goodToken = mintRoleToken();
check("门4e 令牌哈希可验证、错值不可验证", credentialMatches(goodToken, hashCredential(goodToken)) && !credentialMatches(goodToken.slice(0, 8), hashCredential(goodToken)) && !credentialMatches(goodToken, hashCredential(goodToken + "x")));

/* ── 条件录入校验（浏览器交上来的结构化数据，服务端确定性判定） ─────── */
const okInput = sanitizeConditions({ hard: { maxWalkMeters: 6000, mustVisit: ["c1"] }, soft: { c2: "prefer" }, bias: "walk_less" }, "B");
check("V1 合法条件被接受且角色由服务端赋值", okInput.ok && okInput.conditions.role === "B" && okInput.conditions.hard.maxWalkMeters === 6000, okInput);
const cases = [
  [{ role: "B" }, "不认识的顶层字段"],
  [{ hard: { maxMeters: 1 } }, "不认识的 hard 字段"],
  [{ hard: { maxWalkMeters: 1.5 } }, "步行上限不是整数"],
  [{ hard: { maxWalkMeters: 99 } }, "步行上限低于下限"],
  [{ hard: { latestEndMinutes: 2000 } }, "最晚结束超出当天分钟范围"],
  [{ soft: { c1: "must-see" } }, "软偏好档位不在白名单"],
  [{ bias: "cheapest" }, "整体倾向不在白名单"],
  [{ hard: { mustVisit: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"] } }, "站点数量超上限"],
];
for (const [input, label] of cases) {
  const out = sanitizeConditions(input, "A");
  check(`V2 ${label} 被拒绝（不静默替换、不补默认值）`, out.ok === false && typeof out.error === "string" && out.error.length > 0, out.ok ? out.conditions : out.error);
}
check("V2b 空条件合法（不提任何硬约束也是一种表态）", sanitizeConditions({}, "A").ok === true);

/* ── 汇总 ───────────────────────────────────────────────────────── */
const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过（夹具数据，零高德/飞猪/百炼调用）`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
