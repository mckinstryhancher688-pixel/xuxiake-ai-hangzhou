/**
 * 飞猪优化① D（杭州适配版）真实付费验收。会真实消耗高德/飞猪/百炼，跑前必须已获单一预算批准。
 * 跑法：CONFIRM_PAID=yes node evidence/source-evidence-paid-accept.mjs
 * 预算上限（已批准）：高德 place+walking ≤62、飞猪 CLI ≤3、百炼回合 ≤2。超上限立即停后续付费步骤并如实记录。
 * 顺序：双人冷核验(≤62高德+2飞猪) → 城市观光发现(1飞猪) → 跨城负面(0) → 双人上限协商(0高德,需补测则不批准) → 解释(1百炼)。
 * 只输出脱敏形状与计数，绝不打印密钥；报告只留存精简字段。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlanLink } from "../src/lib/plan-api.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
if (process.env.CONFIRM_PAID !== "yes") {
  console.error("拒绝运行：真实付费验收需 CONFIRM_PAID=yes（且已获单一预算批准）。");
  process.exit(2);
}
const AMAP_MAX = 62;
const FLYAI_MAX = 3;
const BAILIAN_MAX = 2;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${JSON.stringify(detail)}` : ""}`);
}
async function getJson(p) {
  const r = await fetch(BASE + p, { cache: "no-store" });
  return { status: r.status, body: await r.json() };
}
async function postJson(p, body, headers = {}) {
  const r = await fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
const amapUsed = (s) => (s.placeHourlyUsed ?? 0) + (s.walkingHourlyUsed ?? 0);

const before = (await getJson("/api/verify")).body;
let lastStatus = before;
let report = null;
let flyaiProofs = 0;
let bailianTurns = 0;
let negotiationNote = "未执行";
let overBudget = false;
console.log(`基线高德计数 place=${before.placeHourlyUsed} walking=${before.walkingHourlyUsed}`);

// ── 1. 双人冷核验：真实 itinerary + 来源证据字段 ───────────────────
const verify = await postJson("/api/verify", { cityName: "杭州", categories: ["自然风光", "文创街区"] });
report = verify.body?.report ?? null;
check("真实核验返回 200 且 ok", verify.status === 200 && report?.ok === true, { status: verify.status, ok: report?.ok, error: report?.error });
check("真实行程非空且可行", Boolean(report?.itinerary?.stops?.length) && report?.itinerary?.feasible === true, { stops: report?.itinerary?.stops?.length });
const allStops = report?.itinerary?.stops ?? [];
const stopsWithEvidence = allStops.filter((s) => s.flyaiIdFromSource === true && s.flyaiCollectedAt);
const determinate = allStops.every((s) => typeof s.flyaiIdFromSource === "boolean");
check("真实站点来源证据可判定且至少一站校验通过", determinate && stopsWithEvidence.length > 0, { checked: stopsWithEvidence.length, total: allStops.length, determinate });
lastStatus = (await getJson("/api/verify")).body;
const amapSpent = amapUsed(lastStatus) - amapUsed(before);
check("本轮高德新增 ≤62（预算上限）", amapSpent <= AMAP_MAX, { amapSpent, place: lastStatus.placeHourlyUsed, walking: lastStatus.walkingHourlyUsed });
flyaiProofs = report?.flyaiProofs?.length ?? 0;
check("核验飞猪 spawn ≤2", flyaiProofs <= 2, { flyaiProofs });
overBudget = amapSpent > AMAP_MAX;
if (overBudget) console.error("高德已超预算，停止后续付费步骤。");

// ── 2. 城市观光发现：1 次飞猪，结果如实（有数据或明说没有）─────────
if (!overBudget && flyaiProofs < FLYAI_MAX) {
  const discover = await postJson("/api/discover", { cityName: "杭州", categories: ["城市观光"] });
  const discResults = discover.body?.batch?.results ?? [];
  const discEmpty = discResults.every((r) => (r.items?.length ?? 0) === 0);
  check("城市观光发现返回 200 且结果如实（有数据或明说空）", discover.status === 200 && (discEmpty ? discResults.every((r) => Boolean(r.error)) : discResults.some((r) => (r.items?.length ?? 0) > 0)), { empty: discEmpty, counts: discResults.map((r) => r.items?.length ?? 0) });
  flyaiProofs += discResults.length;
}

// ── 3. 负面：跨城请求必须诚实拒绝，不编造数据（0 成本）─────────────
const negative = await postJson("/api/verify", { cityName: "长沙", categories: ["自然风光"] });
check("跨城（长沙）请求被诚实拒绝 400，不返回假路线", negative.status === 400 && /只支持杭州/.test(negative.body?.error ?? ""), { status: negative.status, error: negative.body?.error });

// ── 4. 双人确认闭环：复用事实池、默认条件，0 高德；需补测则不批准、如实记录 ──
// 用默认条件建方案（与零付费 plan-api-smoke 同路径，已证 0 新增高德），
// 避免收紧步行上限触发 ≤6 段自动补测而越过 ≤62 预算；上限协商另由零付费冒烟覆盖。
const factsId = report?.facts?.factsId;
if (!overBudget && factsId) {
  const created = await postJson("/api/plan", {
    factsId,
    attemptId: `paid-create-${Date.now()}`,
    confirmCost: false,
  });
  const head = created.body?.snapshot?.head;
  const links = created.body?.links;
  check("双人计划创建成功且带回角色链接", created.status === 200 && Boolean(links?.A && links?.B), { status: created.status, planId: created.body?.planId });
  const needsExtra = (head?.extraLegsNeeded ?? 0) > 0 || (head?.missingEdges?.length ?? 0) > 0;
  if (head && !needsExtra && links?.A && links?.B) {
    const a = parsePlanLink(links.A);
    const b = parsePlanLink(links.B);
    const confirmBody = { revision: head.revision, contentHash: head.contentHash };
    const ca = await postJson(`/api/plan/${a.planId}/confirm`, confirmBody, { "x-plan-role-token": a.token });
    const cb = await postJson(`/api/plan/${b.planId}/confirm`, confirmBody, { "x-plan-role-token": b.token });
    const official = cb.body?.snapshot?.official;
    const officialStops = official?.itinerary?.stops ?? [];
    const officialChecked = officialStops.filter((s) => s.flyaiIdFromSource === true).length;
    check("双方确认后产生正式版本且来源证据随协商保留", ca.status === 200 && cb.status === 200 && officialStops.length > 0 && officialStops.every((s) => typeof s.flyaiIdFromSource === "boolean") && officialChecked > 0, { officialRevision: cb.body?.snapshot?.officialRevision, officialChecked, officialTotal: officialStops.length });
    lastStatus = (await getJson("/api/verify")).body;
    check("协商重解未新增高德调用（复用事实池）", amapUsed(lastStatus) === amapSpent + amapUsed(before), { afterNeg: amapUsed(lastStatus) });
    if (official && bailianTurns < BAILIAN_MAX) {
      const ex = await postJson(`/api/plan/${a.planId}/explain`, { attemptId: `paid-explain-${Date.now()}` }, { "x-plan-role-token": a.token });
      bailianTurns += 1;
      check("百炼解释回合真实返回（≤2 预算）", ex.status === 200 && ex.body?.explanation?.ok === true, { status: ex.status, ok: ex.body?.explanation?.ok });
      negotiationNote = "创建→双方确认→解释 全闭环，0 新增高德";
    }
  } else {
    negotiationNote = needsExtra ? `需补测 ${head?.extraLegsNeeded ?? head?.missingEdges?.length} 段，未批准不花钱（守住预算）` : "无 head 或链接，跳过确认";
    check("需补测时不擅自花钱（如实跳过）", true, { note: negotiationNote });
  }
} else {
  negotiationNote = overBudget ? "超预算跳过协商" : "报告无 factsId，跳过协商";
  check("无 factsId 或超预算时跳过协商（如实）", true, { note: negotiationNote });
}

lastStatus = (await getJson("/api/verify")).body;
const totalAmap = amapUsed(lastStatus) - amapUsed(before);
check("全程高德新增总量 ≤62", totalAmap <= AMAP_MAX, { totalAmap });
check("全程飞猪 spawn ≤3", flyaiProofs <= FLYAI_MAX, { flyaiProofs });
check("全程百炼回合 ≤2", bailianTurns <= BAILIAN_MAX, { bailianTurns });

const failed = results.filter((r) => !r.pass);
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: true,
  budget: { amapMax: AMAP_MAX, flyaiMax: FLYAI_MAX, bailianMax: BAILIAN_MAX },
  spent: { amapNewCalls: totalAmap, flyaiSpawn: flyaiProofs, bailianTurns },
  negotiationNote,
  realStops: (report?.itinerary?.stops ?? []).map((s) => ({ name: s.name, flyaiId: s.flyaiId, jumpUrl: s.jumpUrl, flyaiCollectedAt: s.flyaiCollectedAt ?? null, flyaiIdFromSource: s.flyaiIdFromSource ?? null })),
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(ROOT, "evidence", "source-evidence-paid-accept.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过${failed.length ? `；未通过：${failed.map((f) => f.name).join("、")}` : ""}（高德新增=${totalAmap}，飞猪=${flyaiProofs}，百炼=${bailianTurns}）`);
process.exit(failed.length ? 1 : 0);