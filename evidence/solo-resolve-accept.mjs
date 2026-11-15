/**
 * 单人「事实层免费重解」端到端验收：真实核验一次，之后改上限三次，高德计数必须一动不动。
 *
 * 成本：核验一次会真实消耗高德。若整链缓存仍然有效则 0 新增。
 * 跑前请确认预算；跑法：CONFIRM_PAID=yes node evidence/solo-resolve-accept.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
if (process.env.CONFIRM_PAID !== "yes") {
  console.error("拒绝运行：本脚本可能触发一次真实核验（付费）。需 CONFIRM_PAID=yes 且已获预算批准。");
  process.exit(2);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
};

async function counters() {
  const r = await fetch(BASE + "/api/verify", { cache: "no-store" });
  const j = await r.json();
  return { place: j.placeHourlyUsed, walking: j.walkingHourlyUsed, total: j.placeHourlyUsed + j.walkingHourlyUsed };
}
async function post(p, body) {
  const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { json = { error: "非 JSON 响应" }; }
  return { status: r.status, body: json };
}

const beforeVerify = await counters();
console.log(`起始计数 place=${beforeVerify.place} walking=${beforeVerify.walking}`);

/* 1. 真实核验一次，拿到事实集（单类别即可， cheapest viable：约 36 次高德） */
const verify = await post("/api/verify", { cityName: "杭州", categories: ["自然风光"] });
const report = verify.body?.report;
check("1 真实核验返回可行行程与事实集", verify.status === 200 && report?.ok === true && Boolean(report?.facts?.factsId), {
  status: verify.status,
  ok: report?.ok,
  factsId: report?.facts?.factsId,
  stops: report?.itinerary?.stops?.length,
});
if (!report?.facts?.factsId) {
  console.error("拿不到 factsId，无法验证重解。");
  process.exit(1);
}
const factsId = report.facts.factsId;
const baselineStops = report.itinerary.stops.map((s) => ({ name: s.name, flyaiId: s.flyaiId }));
const baselineWalk = report.itinerary.totalWalkMeters;

const afterVerify = await counters();
const verifySpent = afterVerify.total - beforeVerify.total;
console.log(`核验结束 place=${afterVerify.place} walking=${afterVerify.walking}（本次新增 ${verifySpent}，命中缓存则为 0）`);

/* 2. 三次不同上限重解：高德计数必须完全不变 */
// 85% 是「温和收紧」：通常还能排出 ≥2 站，能真实验证「上限确实改变了方案」
const half = Math.max(600, Math.floor(baselineWalk * 0.85));
const attempts = [
  { label: "不设上限", maxWalkMeters: null },
  { label: `上限 ${half} 米`, maxWalkMeters: half },
  { label: "上限 400 米（大概率排不出）", maxWalkMeters: 400 },
];

const resolved = [];
for (const attempt of attempts) {
  const before = await counters();
  const res = await post("/api/resolve", { factsId, maxWalkMeters: attempt.maxWalkMeters, mustVisit: [], neverAccept: [] });
  const after = await counters();
  const spent = after.total - before.total;
  resolved.push({ attempt, res, spent });
  check(`2 「${attempt.label}」重解未新增任何高德调用`, spent === 0, { spent, newAmapCalls: res.body?.cost?.newAmapCalls });
  check(`2b 「${attempt.label}」响应自己报告 0 新增`, res.body?.cost?.newAmapCalls === 0, res.body?.cost);
}

/* 3. 上限生效：要么解出且不超上限，要么如实报排不出——绝不能返回超限方案 */
const withLimit = resolved.find((item) => item.attempt.maxWalkMeters !== null && item.attempt.maxWalkMeters > 400);
if (withLimit) {
  const limit = withLimit.attempt.maxWalkMeters;
  const body = withLimit.res.body ?? {};
  if (body.ok) {
    const walk = body.itinerary.totalWalkMeters;
    check("3 带上限的方案确实不超过上限（服务端判定）", walk <= limit, { walk, limit });
    check("3b withinLimit 为 true 且 verdict 是人话", body.explanation.withinLimit === true && /在您定的/.test(body.explanation.verdict), body.explanation.verdict);
    check("3c 执行门禁给出允许", body.execution.allowed === true, body.execution.reason);
  } else {
    check("3 带上限时若排不出必须如实说明（不得给超限方案）", typeof body.reason === "string" && /\d+ 米/.test(body.reason), { code: body.code, reason: (body.reason ?? "").slice(0, 80) });
  }
}

/* 4. 排不出时：如实说明 + 给经枚举验证的建议值 */
const impossible = resolved.find((item) => item.attempt.maxWalkMeters === 400);
if (impossible) {
  const body = impossible.res.body ?? {};
  const ok = body.ok === true;
  check("4 上限 400 米时结果必须是「排不出」或「确实不超过 400 米」", !ok || body.itinerary.totalWalkMeters <= 400, { ok, walk: body.itinerary?.totalWalkMeters ?? null });
  if (!ok) {
    check("4b 无解时给出可执行建议值", Boolean(body.suggestion), body.suggestion);
    check("4c 无解原因带真实数字", /\d+ 米/.test(body.reason ?? ""), (body.reason ?? "").slice(0, 100));
  }
}

/* 5. 不设上限那次应与核验结果同量级（同一事实层） */
const free = resolved.find((item) => item.attempt.maxWalkMeters === null);
if (free?.res.body?.ok) {
  check("5 不设上限时用的是同一事实层（站名一致）", free.res.body.itinerary.stops.every((s) => baselineStops.some((b) => b.flyaiId === s.flyaiId)), {
    resolve: free.res.body.itinerary.stops.map((s) => s.name),
    verify: baselineStops.map((b) => b.name),
  });
  check("5b 重解给出的总步行与核验一致（未受其他约束影响时为同一解）", Math.abs(free.res.body.itinerary.totalWalkMeters - baselineWalk) <= 1, { resolve: free.res.body.itinerary.totalWalkMeters, verify: baselineWalk });
}

/* 6. 参数校验：非法上限必须 400，不许静默接受 */
const badLimit = await post("/api/resolve", { factsId, maxWalkMeters: 50 });
check("6 非法上限（50 米）被拒绝 400", badLimit.status === 400, { status: badLimit.status, error: badLimit.body?.error });
const badFacts = await post("/api/resolve", { factsId: "does-not-exist" });
check("6b 不存在的事实集返回 410 且不自动重跑", badFacts.status === 410 && badFacts.body?.code === "facts-unavailable", { status: badFacts.status });
const getResolve = await fetch(BASE + "/api/resolve");
check("6c GET 被明确拒绝 405", getResolve.status === 405);

/* 7. 全程总量：重解阶段必须 0 */
const finalCounters = await counters();
const resolveSpent = finalCounters.total - afterVerify.total;
check("7 全部重解阶段合计 0 新增高德", resolveSpent === 0, { resolveSpent, afterVerify, finalCounters });

const failed = results.filter((item) => !item.pass);
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  realStops: baselineStops,
  baselineWalk,
  verifySpent,
  resolveSpent,
  counters: { beforeVerify, afterVerify, finalCounters },
  attempts: resolved.map((item) => ({
    label: item.attempt.label,
    maxWalkMeters: item.attempt.maxWalkMeters,
    ok: item.res.body?.ok ?? null,
    walk: item.res.body?.itinerary?.totalWalkMeters ?? null,
    stops: item.res.body?.itinerary?.stops?.length ?? null,
    newAmapCalls: item.res.body?.cost?.newAmapCalls ?? null,
    spentDuringCall: item.spent,
  })),
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(ROOT, "evidence", "solo-resolve-accept.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过（核验新增 ${verifySpent}，重解阶段新增 ${resolveSpent}）`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
