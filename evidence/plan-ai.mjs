import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildNegotiationBrief } from "../src/lib/negotiation/ai-context.ts";
import { emptyConditions } from "../src/lib/negotiation/types.ts";
import { makeCompleteFacts } from "./negotiation-fixture.ts";
import { agentScopeKey, agentTurnKey } from "../src/lib/server/plan-tickets.ts";

/**
 * 双人协商 × 百炼的零付费验收。
 *
 * 两件事分开证：
 *   1. 事实块（buildNegotiationBrief）只搬运服务端已经算好的东西——纯函数、夹具数据；
 *   2. 服务端链路（AI 读的行程、角色隔离、失败如实）用真实模块跑，但把 globalThis.fetch
 *      换成会抛错的桩：任何一步想去碰高德/百炼都会当场暴露，本套件不会花一分钱。
 *
 * 跑法：`node --import ./evidence/register-alias.mjs evidence/plan-ai.mjs`
 */

const results = [];

// 这个套件会真的走 runPlanMutation → 落盘。不指到临时目录就会把夹具方案写进项目的 .data/，
// 正在跑的开发实例下次启动会把它们当成真实方案恢复出来。
process.env.PLAN_SNAPSHOT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xuxiake-plan-ai-")), "snapshot.json");
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const outbound = [];
globalThis.fetch = async (input) => {
  const url = String(input);
  outbound.push(url);
  throw new Error(`本套件不允许真实外部调用：${url.slice(0, 60)}`);
};

// 让 requireConfig 通过，好把「行程解析」这一步单独隔离出来观察；密钥是假的，且 fetch 已被桩替换
process.env.DASHSCOPE_API_KEY = "fake-for-zero-cost-test";
process.env.BAILIAN_WORKSPACE_ID = "ws-fake";
process.env.BAILIAN_AGENT_ID = "agent-fake";
process.env.BAILIAN_ENV_ID = "env-fake";

const store = await import("../src/lib/server/plan-store.ts");
const agent = await import("../src/lib/server/agent.ts");
const factsStore = await import("../src/lib/server/facts.ts");

const facts = makeCompleteFacts();
facts.measuredAt = new Date().toISOString();
factsStore.putFactSet(facts);
const created = store.createPlanRecord({ facts, conditionsA: emptyConditions("A"), now: new Date() });
const planId = created.planId;

await store.runPlanMutation(planId, {
  kind: "conditions", role: "A", conditions: emptyConditions("A"),
  expectedRevision: null, attemptId: "ai-a", confirmCost: false,
});
await store.runPlanMutation(planId, {
  kind: "conditions", role: "B",
  conditions: { ...emptyConditions("B"), hard: { ...emptyConditions("B").hard, maxWalkMeters: 3000 } },
  expectedRevision: 1, attemptId: "ai-b", confirmCost: false,
});

/* ── 1. 事实块：只搬运服务端结论 ─────────────────────────────────── */

const brief = buildNegotiationBrief(store.planForBrief(planId));
check("1 事实块里两边条件都在（含步行上限与倾向）",
  brief.block.includes("A：") && brief.block.includes("B：") && /3000 米|3\.00 公里/.test(brief.block) && brief.block.includes("倾向"),
  { 条件行: brief.block.split("\n").filter((line) => line.startsWith("【双方条件】")).map((line) => line.slice(0, 56)) });
check("2 事实块带服务端判定与当前版本", /【服务端判定】/.test(brief.block) && /【当前版本】v2/.test(brief.block));
const diffLine = (brief.block.split("【真实差异】")[1] ?? "").split("\n")[0];
const diffPair = diffLine.match(/总步行\s*([\d.]+)\s*(公里|米)\s*→\s*([\d.]+)\s*(公里|米)/);
const asMeters = (value, unit) => (unit === "公里" ? Math.round(parseFloat(value) * 1000) : Math.round(parseFloat(value)));
const diffFrom = diffPair ? asMeters(diffPair[1], diffPair[2]) : -1;
const diffTo = diffPair ? asMeters(diffPair[3], diffPair[4]) : -1;
check("3 差异行同时给出前后两个数字，方向词与真实变化一致（不隐藏增加）",
  diffPair !== null &&
    (diffTo < diffFrom ? diffLine.includes("少走") : diffTo > diffFrom ? diffLine.includes("多走") : diffLine.includes("不变")),
  { 差异行: diffLine.slice(0, 110), diffFrom, diffTo });
check("4 口径说明原文进了事实块", brief.block.includes("步行上限只统计"));
const numbers = [...brief.block.matchAll(/([\d,]+(?:\.\d+)?)\s*(米|公里|千米|分钟)/g)];
const outside = numbers
  .map((match) => {
    const value = Number(match[1].replace(/,/g, ""));
    const scaled = match[2] === "公里" || match[2] === "千米" ? Math.round(value * 1000) : Math.round(value);
    return { text: match[0], scaled, unit: match[2] };
  })
  .filter((item) => (item.unit === "分钟" ? !brief.factMinutes.includes(item.scaled) : !brief.factMeters.includes(item.scaled)));
check("5 块里出现的每个数字都在对账清单里（模型照抄就不会误判）", outside.length === 0, { 漏网: outside.slice(0, 3) });
check("6 事实块不编造任何价格：没有一项带数字的门票/花费", !/[\d.]+\s*元|¥\s*[\d.]+|门票\s*[:：]?\s*[\d.]/.test(brief.block));
check("7 下一步选项都由服务端生成且带真实补测报价",
  brief.options.length > 0 &&
    new Set(brief.options.map((option) => option.key)).size === brief.options.length &&
    brief.options.every((option) => option.extraCalls === null || (Number.isInteger(option.extraCalls) && option.extraCalls >= 0)),
  { 选项: brief.options.map((option) => `${option.key}:${option.extraCalls}`) });
check("8 有步行上限时给出「由本人调整」这一类选项", brief.options.some((option) => option.key.startsWith("relax-cap-")));
check("9 未确认状态下选项不说成已生效，且要求当事人自己确认",
  brief.options.every((option) => !option.text.includes("已生效")) &&
    brief.options.some((option) => option.text.includes("确认")) &&
    brief.options.some((option) => option.text.includes("自己")));

/* 3b. 真的少走了：差异必须出现负号（不隐藏增加，也不把减少写成中性） */
const tight = store.createPlanRecord({ facts, conditionsA: emptyConditions("A"), now: new Date() });
await store.runPlanMutation(tight.planId, {
  kind: "conditions", role: "A", conditions: emptyConditions("A"),
  expectedRevision: null, attemptId: "tight-a", confirmCost: false,
});
const tightV1 = store.planSnapshot(tight.planId, "A").head.itinerary.totalWalkMeters;
await store.runPlanMutation(tight.planId, {
  kind: "conditions", role: "B",
  conditions: { ...emptyConditions("B"), hard: { ...emptyConditions("B").hard, maxWalkMeters: Math.max(200, tightV1 - 800) } },
  expectedRevision: 1, attemptId: "tight-b", confirmCost: false,
});
const tightSnap = store.planSnapshot(tight.planId, "B");
const tightDiff = (tightSnap.head?.diff?.lines ?? []).find((line) => line.includes("总步行")) ?? "";
check("3b 路线真的变短时差异写出「少走」与负号",
  tightV1 - 800 >= 200 && tightSnap.headRevision === 2 && tightSnap.head.itinerary.totalWalkMeters < tightV1 &&
    tightDiff.includes("少走") && tightDiff.includes("−"),
  { tightV1, now: tightSnap.head?.itinerary?.totalWalkMeters, tightDiff });

/* ── 2. 服务端链路：AI 读的行程必须与地图同一份 ───────────────────── */

check("10 未双方确认时执行行程是空的", store.planExecutionJourney(planId) === null, {
  reason: store.executionBlockReason(planId),
});

const beforeArrive = outbound.length;
const refused = await agent.exploreWithAgent(
  { cityName: "杭州", stopId: null, interests: [], categories: [], plan: { planId, role: "A" } },
  null,
);
check("11 未确认时双人「我到了」被服务端拒绝，且没有拿单人路线顶数",
  refused.ok === false && /没有可正式执行/.test(refused.error ?? "") && refused.proof === null,
  { error: refused.error });
check("11b 这一步没有新增任何外部请求", outbound.length === beforeArrive, { added: outbound.slice(beforeArrive) });

const explainFailed = await agent.explainNegotiation({ planId, role: "A" });
check("12 AI 解释失败时如实返回错误，不返回固定文案",
  explainFailed.ok === false && typeof explainFailed.error === "string" && explainFailed.error.length > 0 && explainFailed.summary === null,
  { error: (explainFailed.error ?? "").slice(0, 80) });
const explainFailedB = await agent.explainNegotiation({ planId, role: "B" });
check("12b 失败的解释只带出脱敏作用域哈希，两角色的不同，也不含方案编号",
  /^[0-9a-f]{12}$/.test(explainFailed.scopeKey ?? "") &&
    explainFailed.scopeKey !== explainFailedB.scopeKey &&
    !(explainFailed.scopeKey ?? "").includes(planId.slice(0, 6)),
  { A: explainFailed.scopeKey, B: explainFailedB.scopeKey });

check("13 全程没有发出过高德请求", outbound.filter((url) => url.includes("restapi.amap.com")).length === 0, {
  高德: outbound.filter((url) => url.includes("restapi.amap.com")).slice(0, 2),
});

/* 双方确认同一版本之后 */
const head = store.planSnapshot(planId, "A");
await store.runPlanMutation(planId, { kind: "confirm", role: "B", revision: head.headRevision, contentHash: head.head.contentHash });
await store.runPlanMutation(planId, { kind: "confirm", role: "A", revision: head.headRevision, contentHash: head.head.contentHash });
const journey = store.planExecutionJourney(planId);
check("14 双方确认后执行行程出现，且与快照里的正式版本同源",
  journey !== null && journey.itinerary.totalWalkMeters === store.planSnapshot(planId, "A").official.itinerary.totalWalkMeters,
  { revision: journey?.officialRevision, meters: journey?.itinerary.totalWalkMeters });

const beforeConfirm = outbound.length;
const arrivedAfter = await agent.exploreWithAgent(
  { cityName: "杭州", stopId: journey.itinerary.stops[0].flyaiId, interests: [], categories: [], plan: { planId, role: "A" } },
  null,
);
check("15 确认后 AI 读的就是这一版：失败点已经不在行程解析上",
  arrivedAfter.ok === false && !/没有可正式执行/.test(arrivedAfter.error ?? "") && /外部调用|百炼|会话/.test(arrivedAfter.error ?? ""),
  { error: (arrivedAfter.error ?? "").slice(0, 90) });
check("15b 双人「我到了」不把服务端作用域键回传给浏览器", arrivedAfter.token === null, { token: arrivedAfter.token });
check("16 这一步只撞到百炼边界，仍然没有高德请求",
  outbound.length > beforeConfirm && outbound.filter((url) => url.includes("restapi.amap.com")).length === 0,
  { 新增: outbound.slice(beforeConfirm).map((url) => url.slice(0, 34)) });

/* ── 3. 角色隔离 ─────────────────────────────────────────────────── */

const itineraryKey = journey.itinerary.stops.map((stop) => stop.flyaiId).join(",");
const scopeA = agentScopeKey(planId, "A", itineraryKey);
const scopeB = agentScopeKey(planId, "B", itineraryKey);
check("17 会话作用域按角色分开", scopeA !== scopeB && scopeA.includes("|A|") && scopeB.includes("|B|"));
const turnA = agentTurnKey(planId, "A", "explain", "scoped", "current");
const turnB = agentTurnKey(planId, "B", "explain", "scoped", "current");
const turnSolo = agentTurnKey(planId, "A", "explain", "other-ticket", "current");
check("18 回合去重键按角色与票据分开，A 的在飞回合不会被 B 复用", turnA !== turnB && turnA !== turnSolo);
const asB = store.identifyRole(planId, created.tokens.B);
const asScope = store.identifyRole(planId, scopeA);
const asPlanId = store.identifyRole(planId, planId);
check("19 凭据只认角色令牌：B 的令牌只指向 B，公开字段拼出来的作用域键与 planId 本身都进不来",
  asB.role === "B" && "error" in asScope && "error" in asPlanId,
  { B: asB, 作用域键: asScope, planId: asPlanId });
check("19b 对外的解释响应里没有任何会话键，只有 12 位截断哈希",
  /^[0-9a-f]{12}$/.test(String(explainFailed.scopeKey ?? "")) &&
    !JSON.stringify(explainFailed).includes(scopeA) &&
    !JSON.stringify(explainFailed).includes(scopeB));

const passed = results.filter((item) => item.pass).length;
console.log(`\n${passed}/${results.length} 通过（夹具事实 + 假密钥 + fetch 桩，零高德/飞猪/百炼真实调用）`);
process.exit(passed === results.length ? 0 : 1);
