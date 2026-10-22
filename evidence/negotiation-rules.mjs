import {
  canExecute,
  confirmRevision,
  createPlan,
  executionRoute,
  headRevisionOf,
  officialRevisionOf,
  proposeRoute,
  submitConditions,
} from "../src/lib/negotiation/plan-state.ts";
import { makeCompleteFacts, makeShortlistedFacts } from "./negotiation-fixture.ts";

/**
 * 状态规则的独立验收：这一组只管「规则有没有被绕过」，零高德、零飞猪、零百炼。
 *
 * 与 evidence/negotiation-unit.mjs 的分工：那边是四道门的主干（求解、报价、配额、票据），
 * 这边专门盯容易在改动中失守的边角——挂起后不许复活、过期请求不许先花钱、
 * 相同内容也必须开新版本、提案失败不许动正式版。
 * 夹具里的失败都是**明确标注的模拟失败**，与产品拿 Mock 冒充真实结果是两回事。
 *
 * 跑法：`node evidence/negotiation-rules.mjs`
 */

const START_AT = new Date("2026-10-21T13:00:00");
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

function cond(role, over = {}) {
  return {
    role,
    hard: { latestEndMinutes: null, maxWalkMeters: null, mustVisit: [], neverAccept: [], ...(over.hard ?? {}) },
    soft: over.soft ?? {},
    bias: over.bias ?? "neutral",
  };
}

function freshPlan(facts, a = cond("A")) {
  const state = createPlan("rules-plan", facts, a, START_AT);
  state.expiresAt = new Date(START_AT.getTime() + 72 * 60 * 60 * 1000).toISOString();
  return state;
}

function measureSpy({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    measure: async (edges) => {
      calls.push(edges.map((edge) => edge.key));
      return fail
        ? { ok: false, error: "夹具注入的模拟失败（不是高德返回）", retries: 0, simulated: true, legs: {} }
        : { ok: true, legs: {}, retries: 0 };
    },
  };
}

/* R1 新硬条件先落账再求解：补测失败也不许让旧超限路线复活 */
{
  // 短名单夹具里 s7 只测过「起点→它」，两两关系没测过 → 必须去它一定会触发补测
  const facts = makeShortlistedFacts();
  const state = freshPlan(facts);
  const spy = measureSpy({ fail: true });
  await submitConditions(state, facts, {
    role: "A", conditions: cond("A"), expectedRevision: null, attemptId: "r1-a", now: START_AT, measure: spy.measure,
  });
  const v1 = headRevisionOf(state);
  confirmRevision(state, { role: "A", revision: v1.revision, contentHash: v1.contentHash, now: START_AT });
  confirmRevision(state, { role: "B", revision: v1.revision, contentHash: v1.contentHash, now: START_AT });
  const wasOfficial = state.officialRevision;
  const tooTight = Math.max(200, v1.itinerary.totalWalkMeters - 1);
  const failed = await submitConditions(state, facts, {
    role: "B",
    conditions: cond("B", { hard: { maxWalkMeters: tooTight, mustVisit: ["s7"] } }),
    expectedRevision: v1.revision,
    attemptId: "r1-b",
    confirmCost: true,
    now: START_AT,
    measure: spy.measure,
  });
  check("R1 需要补测的条件确实触发了补测（夹具注入失败）", failed.code === "measurement-failed" && spy.calls.length === 1, {
    code: failed.code, 补测次数: spy.calls.length,
  });
  check("R1b 新硬条件已经落下，没有因为失败被回退",
    state.conditions.B?.hard.maxWalkMeters === tooTight && state.status === "paused",
    { cap: state.conditions.B?.hard.maxWalkMeters, status: state.status });
  check("R1c 旧确认仍然挂起，超限的旧路线不能恢复为正式路线",
    state.officialRevision === null && officialRevisionOf(state) === null && canExecute(state, START_AT).allowed === false &&
      executionRoute(state, START_AT) === null,
    { 曾经是: wasOfficial, reason: canExecute(state, START_AT).reason });
}

/* R2 未接受的提案失败：原有正式版本必须原地不动 */
{
  const facts = makeCompleteFacts();
  const state = freshPlan(facts);
  const spy = measureSpy();
  await submitConditions(state, facts, {
    role: "A", conditions: cond("A"), expectedRevision: null, attemptId: "r2-a", now: START_AT, measure: spy.measure,
  });
  const v1 = headRevisionOf(state);
  confirmRevision(state, { role: "A", revision: v1.revision, contentHash: v1.contentHash, now: START_AT });
  confirmRevision(state, { role: "B", revision: v1.revision, contentHash: v1.contentHash, now: START_AT });
  const before = state.officialRevision;
  // 把事实层里跟这一版相关的实测段抽掉，让「只提提案」这一步当场无解
  const proposal = await proposeRoute(state, facts, {
    role: "B", expectedRevision: v1.revision, attemptId: "r2-p", now: START_AT, measure: spy.measure,
  });
  check("R2 提案这一步不挂起旧确认", proposal.code === "ok" && state.officialRevision === before, {
    code: proposal.code, official: state.officialRevision,
  });
  for (const key of Object.keys(facts.legs)) delete facts.legs[key];
  const broken = await proposeRoute(state, facts, {
    role: "A", expectedRevision: state.headRevision,
    attemptId: "r2-p2", now: START_AT, measure: spy.measure,
  });
  check("R2b 提案求解失败时正式版本与执行入口都不受影响",
    broken.code === "no-solution" && state.officialRevision === before && canExecute(state, START_AT).allowed === true,
    { code: broken.code, official: state.officialRevision, gate: canExecute(state, START_AT).reason });
}

/* R3 A 确认 v1、B 确认 v2：不算双方确认 */
{
  const facts = makeCompleteFacts();
  const state = freshPlan(facts);
  const spy = measureSpy();
  await submitConditions(state, facts, {
    role: "A", conditions: cond("A"), expectedRevision: null, attemptId: "r3-a", now: START_AT, measure: spy.measure,
  });
  const v1 = headRevisionOf(state);
  confirmRevision(state, { role: "A", revision: v1.revision, contentHash: v1.contentHash, now: START_AT });
  await submitConditions(state, facts, {
    role: "B",
    conditions: cond("B", { hard: { maxWalkMeters: Math.max(200, v1.itinerary.totalWalkMeters - 800) } }),
    expectedRevision: v1.revision, attemptId: "r3-b", now: START_AT, measure: spy.measure,
  });
  const v2 = headRevisionOf(state);
  const bOnV2 = confirmRevision(state, { role: "B", revision: v2.revision, contentHash: v2.contentHash, now: START_AT });
  check("R3 A 确认过 v1、B 确认 v2 不构成双方确认",
    state.officialRevision === null && bOnV2.message.includes("等待 A") && canExecute(state, START_AT).allowed === false,
    { message: bOnV2.message });
  const staleConfirm = confirmRevision(state, { role: "A", revision: v1.revision, contentHash: v1.contentHash, now: START_AT });
  check("R3b 旧版本的确认在新版本出现后立刻不可用", staleConfirm.code === "not-confirmable", { code: staleConfirm.code });
  const onV2 = confirmRevision(state, { role: "A", revision: v2.revision, contentHash: v2.contentHash, now: START_AT });
  check("R3c 两人都确认 v2 之后才正式生效", onV2.code === "ok" && state.officialRevision === v2.revision, {
    official: state.officialRevision,
  });
}

/* R4 内容退回旧版也要开新版本，旧确认不许挪过来 */
{
  const facts = makeCompleteFacts();
  const state = freshPlan(facts);
  const spy = measureSpy();
  await submitConditions(state, facts, {
    role: "A", conditions: cond("A"), expectedRevision: null, attemptId: "r4-a", now: START_AT, measure: spy.measure,
  });
  const v1 = headRevisionOf(state);
  await submitConditions(state, facts, {
    role: "B",
    conditions: cond("B", { hard: { maxWalkMeters: Math.max(200, v1.itinerary.totalWalkMeters - 800) } }),
    expectedRevision: v1.revision, attemptId: "r4-b", now: START_AT, measure: spy.measure,
  });
  const v2 = headRevisionOf(state);
  confirmRevision(state, { role: "A", revision: v2.revision, contentHash: v2.contentHash, now: START_AT });
  confirmRevision(state, { role: "B", revision: v2.revision, contentHash: v2.contentHash, now: START_AT });
  // B 撤回上限：结果与 v1 走法相同，但当事双方变了，指纹自然不同
  const withdrawn = cond("B");
  await submitConditions(state, facts, {
    role: "B", conditions: withdrawn, expectedRevision: v2.revision, attemptId: "r4-c", now: START_AT, measure: spy.measure,
  });
  const v3 = headRevisionOf(state);
  check("R4 撤回条件后仍是新版本，旧确认不跟着走",
    v3.revision === (v2.revision ?? 0) + 1 && v3.confirmations.A === null && state.officialRevision === null,
    { v3: v3.revision, status: v3.status, official: state.officialRevision });
  // 再提交一次一模一样的条件：内容完全相同，也必须开新版本、也不能带旧确认
  await submitConditions(state, facts, {
    role: "B", conditions: withdrawn, expectedRevision: v3.revision, attemptId: "r4-d", now: START_AT, measure: spy.measure,
  });
  const v4 = headRevisionOf(state);
  check("R4b 恢复相同内容也产生新 revision，并且如实标成 rolled-back-content",
    v4.revision === (v3.revision ?? 0) + 1 && v4.contentHash === v3.contentHash && v4.status === "rolled-back-content",
    { v4: v4.revision, 同内容: v4.contentHash === v3.contentHash, status: v4.status });
  check("R4c 新版本的确认是空的，正式执行入口仍然关着",
    v4.confirmations.A === null && v4.confirmations.B === null && state.officialRevision === null &&
      canExecute(state, START_AT).allowed === false && executionRoute(state, START_AT) === null,
    { reason: canExecute(state, START_AT).reason });
}

/* R5 过期请求不许先消耗补测额度 */
{
  const facts = makeShortlistedFacts();
  const state = freshPlan(facts);
  const spy = measureSpy();
  await submitConditions(state, facts, {
    role: "A", conditions: cond("A"), expectedRevision: null, attemptId: "r5-a", now: START_AT, measure: spy.measure,
  });
  const v1 = headRevisionOf(state);
  await submitConditions(state, facts, {
    role: "B",
    conditions: cond("B", { hard: { mustVisit: ["s7"] } }),
    expectedRevision: v1.revision, attemptId: "r5-b", confirmCost: true, now: START_AT, measure: spy.measure,
  });
  const spentAfterValid = state.budget.spentThisPlan;
  const stale = await submitConditions(state, facts, {
    role: "A",
    // 同样是要补测的条件，但基于过期版本：必须在花钱之前就被拒
    conditions: cond("A", { hard: { mustVisit: ["s8"] } }),
    expectedRevision: v1.revision, attemptId: "r5-c", confirmCost: true, now: START_AT, measure: spy.measure,
  });
  check("R5 过期请求先被版本检查挡下", stale.code === "stale-revision", { code: stale.code });
  check("R5b 挡下之前一次补测都没发生，额度一分没动",
    spy.calls.length === 1 && state.budget.spentThisPlan === spentAfterValid && state.budget.logicalRequests === spentAfterValid,
    { 补测调用批次: spy.calls.length, spentThisPlan: state.budget.spentThisPlan });
  check("R5c 过期请求留下了一条可读的尝试记录",
    state.attempts.some((attempt) => attempt.attemptId === "r5-c" && attempt.status === "rejected:stale-revision" && attempt.legsSpent === 0));
}

/* R6 成本批准越不过硬上限，且不许先花钱再拒绝 */
{
  const facts = makeShortlistedFacts();
  const state = freshPlan(facts);
  const spy = measureSpy();
  await submitConditions(state, facts, {
    role: "A", conditions: cond("A"), expectedRevision: null, attemptId: "r6-a", now: START_AT, measure: spy.measure,
  });
  const v1 = headRevisionOf(state);
  state.budget.spentThisPlan = state.budget.perPlanHardMax - 1;
  const over = await submitConditions(state, facts, {
    role: "B",
    conditions: cond("B", { hard: { mustVisit: ["s7"] } }),
    expectedRevision: v1.revision, attemptId: "r6-b", confirmCost: true, now: START_AT, measure: spy.measure,
  });
  check("R6 confirmCost 越不过本方案硬上限", over.code === "quota" && spy.calls.length === 0, { code: over.code });
  check("R6b 拒绝发生在花钱之前", state.budget.spentThisPlan === state.budget.perPlanHardMax - 1, {
    spent: state.budget.spentThisPlan,
  });
}

/* R7 软偏好落空只算「需要再谈」，不许报成硬约束不可行 */
{
  const facts = makeCompleteFacts();
  const state = freshPlan(facts);
  const spy = measureSpy();
  await submitConditions(state, facts, {
    role: "A",
    conditions: cond("A", { soft: { c1: "prefer" }, bias: "walk_less" }),
    expectedRevision: null, attemptId: "r7-a", now: START_AT, measure: spy.measure,
  });
  const head = headRevisionOf(state);
  check("R7 仍然出方案，且状态不是硬冲突",
    ["soft-imbalanced", "found"].includes(head.solve.kind) && head.solve.kind !== "hard-conflict",
    { kind: head.solve.kind });
  check("R7b 界面文案里没有「不可行」这种越界结论", !/无法同时满足|不可行/.test(head.solve.note), { note: head.solve.note.slice(0, 80) });
}

/* R8 差异不许隐藏增加：放宽上限后路线变长，必须写「多走」和正号 */
{
  const facts = makeCompleteFacts();
  const state = freshPlan(facts);
  const spy = measureSpy();
  await submitConditions(state, facts, {
    role: "A",
    conditions: cond("A", { hard: { maxWalkMeters: 1000 } }),
    expectedRevision: null, attemptId: "r8-a", now: START_AT, measure: spy.measure,
  });
  const short = headRevisionOf(state);
  await submitConditions(state, facts, {
    role: "A",
    conditions: cond("A", { hard: { maxWalkMeters: 6000 }, bias: "see_more" }),
    expectedRevision: short.revision, attemptId: "r8-b", now: START_AT, measure: spy.measure,
  });
  const long = headRevisionOf(state);
  const grew = long.itinerary.totalWalkMeters > short.itinerary.totalWalkMeters;
  const line = (long.diff?.lines ?? []).find((text) => text.includes("总步行")) ?? "";
  check("R8 路线真的变长了", grew, { 前: short.itinerary.totalWalkMeters, 后: long.itinerary.totalWalkMeters });
  check("R8b 变长时差异写「多走」并带正号，不假装省了", line.includes("多走") && line.includes("+"), { 差异行: line });
}

/* R9 撤销之后任何动作都是 plan-dead */
{
  const facts = makeCompleteFacts();
  const state = freshPlan(facts);
  const spy = measureSpy();
  await submitConditions(state, facts, {
    role: "A", conditions: cond("A"), expectedRevision: null, attemptId: "r9-a", now: START_AT, measure: spy.measure,
  });
  state.revoked = true;
  const dead = await submitConditions(state, facts, {
    role: "B", conditions: cond("B"), expectedRevision: state.headRevision, attemptId: "r9-b", now: START_AT, measure: spy.measure,
  });
  const deadConfirm = confirmRevision(state, {
    role: "A", revision: state.headRevision ?? 1, contentHash: headRevisionOf(state)?.contentHash ?? "", now: START_AT,
  });
  check("R9 撤销后写操作全部拒绝", dead.code === "plan-dead" && deadConfirm.code === "plan-dead", {
    dead: dead.code, confirm: deadConfirm.code,
  });
  check("R9b 撤销后执行门禁关闭", canExecute(state, START_AT).allowed === false && executionRoute(state, START_AT) === null);
}

const passed = results.filter((item) => item.pass).length;
console.log(`\n${passed}/${results.length} 通过（夹具数据，零高德/飞猪/百炼调用）`);
process.exit(passed === results.length ? 0 : 1);
