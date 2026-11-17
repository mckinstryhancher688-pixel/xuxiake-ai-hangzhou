/**
 * 【界面部分已过期，不能直接跑】第 6 项起的浏览器步骤针对旧界面写成（米数档位、「一口气最多走多远」单段框、
 * aria-label「爸妈能走多远」），现在界面只剩一条「爸妈全程一共能走多久」（分钟），那些选择器对不上。
 * 接口层（/api/resolve 的 maxWalkMeters / maxSegmentMeters）仍然支持，所以本脚本里直接调接口的部分仍有效。
 * 要重做真机验收，先参照 evidence/preflight-ui.mjs（零付费，已按新界面写好）改写浏览器部分，
 * 且跑之前必须先单独报预算并获批。
 *
 * 亲情版真机验收：一次真实核验 → 浏览器里改「总步行」与「单段上限」→ 证明 0 新增高德调用。
 *
 * 成本：一次核验（单类别，约 27 次高德 + 1 次无障碍洗手间查询）。
 * 跑法：CONFIRM_PAID=yes node evidence/family-real-accept.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
if (process.env.CONFIRM_PAID !== "yes") {
  console.error("拒绝运行：本脚本会触发一次真实核验（付费）。需 CONFIRM_PAID=yes 且已获批准。");
  process.exit(2);
}

const CLI = [
  process.env.PLAYWRIGHT_CLI_PACKAGE,
  path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@playwright", "cli", "package.json"),
].filter(Boolean);
function loadPlaywright() {
  for (const c of CLI) { try { return createRequire(c)("playwright"); } catch { /* next */ } }
  return createRequire(import.meta.url)("playwright");
}
const { chromium } = loadPlaywright();
const EXEC = [
  process.env.PLAYWRIGHT_CHROME,
  path.join(os.homedir(), "AppData", "Local", "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe"),
].filter(Boolean).find((p) => fs.existsSync(p));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
};
async function counters() {
  const r = await fetch(BASE + "/api/verify", { cache: "no-store" });
  const j = await r.json();
  return { place: j.placeHourlyUsed, walking: j.walkingHourlyUsed, total: j.placeHourlyUsed + j.walkingHourlyUsed, cache: j.cacheEntries };
}

/* ── 1. 取一份可行报告：优先用整链缓存（0 新增），必要时才真跑 ──────── */
const before = await counters();
console.log(`起始计数 place=${before.place} walking=${before.walking}`);

const categories = (process.env.VERIFY_CATEGORIES ?? "自然风光,文创街区").split(",").map((s) => s.trim()).filter(Boolean);
let verifyRes = null;
let report = null;
let afterVerify = before;
for (const cat of categories) {
  const res = await fetch(BASE + "/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cityName: "杭州", categories: [cat] }),
  });
  const body = await res.json();
  const now = await counters();
  const spent = now.total - before.total;
  console.log(`  类别「${cat}」=> ok=${body?.report?.ok} 站数=${body?.report?.itinerary?.stops?.length ?? 0} 累计新增=${spent}`);
  if (body?.report?.ok === true) {
    verifyRes = res; report = body.report; afterVerify = now;
    break;
  }
  afterVerify = now;
}
const verifySpent = afterVerify.total - before.total;

check("1 取得一份可行的真实报告", Boolean(report), { categories, verifySpent });
check("2 核验产出可行行程", report?.ok === true && (report?.itinerary?.stops?.length ?? 0) >= 2, {
  ok: report?.ok, stops: report?.itinerary?.stops?.length, insufficiency: report?.insufficiency?.slice(0, 70),
});
if (report?.ok !== true) {
  console.log("\n所有类别都没能产出可行路线（真实数据不凑巧），本次无法继续。这属于产品正确行为，不是代码缺陷。");
  const summary = {
    checkedAt: new Date().toISOString(), baseUrl: BASE, paid: true,
    outcome: "verify-not-feasible", verifySpent, categoriesTried: categories,
    total: results.length, passed: results.filter((r) => r.pass).length, checks: results,
  };
  fs.writeFileSync(path.join(EVIDENCE, "family-real-accept.json"), JSON.stringify(summary, null, 2));
  process.exit(1);
}

const factsId = report.facts.factsId;
const stops = report.itinerary.stops;
const totalWalk = report.itinerary.totalWalkMeters;
const longestSeg = Math.max(...report.itinerary.legs.map((l) => l.distanceMeters));

check("3 核验带来源证据与无障碍洗手间查询", stops.every((s) => typeof s.flyaiIdFromSource === "boolean") && Boolean(report.toilets), {
  checked: stops.filter((s) => s.flyaiIdFromSource === true).length,
  total: stops.length,
  toiletFound: report.toilets?.found ?? null,
  toiletNearest: report.toilets?.nearest?.length ?? 0,
});
check("4 本次核验高德新增在预算内（≤30）", verifySpent <= 30, { verifySpent, afterVerify });
console.log(`真实行程：${stops.map((s) => s.name).join(" / ")}`);
console.log(`总步行 ${totalWalk} 米，最长一段 ${longestSeg} 米`);

/* ── 2. 浏览器：改总上限与单段上限，全程 0 新增 ─────────────── */
const browser = await chromium.launch({ headless: false, executablePath: EXEC, args: ["--lang=zh-CN"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
let blockedExternal = 0;
const resolvePosts = [];
await context.route("**/*", (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "POST" && /\/api\/resolve/.test(url)) { resolvePosts.push(JSON.parse(req.postData() ?? "{}")); return route.continue(); }
  // 拦截核验/几何/百炼：本段只验证重解不花钱
  if (req.method() === "POST" && /\/api\/(verify|route-geometry|agent|plan)/.test(url)) return route.abort();
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1") return route.continue();
  } catch { /* ignore */ }
  blockedExternal += 1;
  return route.abort();
});
await context.addInitScript(([k, v]) => { sessionStorage.setItem(k, v); }, [
  "xuxiake.session.route",
  JSON.stringify({ cityName: "杭州", report, usedCategories: report.categories ?? ["自然风光"] }),
]);

const page = await context.newPage();
const dialogs = [];
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.getByRole("button", { name: "行程与探索", exact: true }).click().catch(() => {});
await page.waitForTimeout(1500);

const pageText = await page.evaluate(() => document.body.innerText);
check("5 面板显示真实站点名", stops.slice(0, 2).every((s) => pageText.includes(s.name)), { names: stops.map((s) => s.name) });
check("6 「爸妈能走多远？」与「一口气最多走多远？」都在", pageText.includes("爸妈能走多远") && pageText.includes("一口气最多走多远"));
check("7 显示当前最长一段的真实米数", pageText.includes(`${longestSeg} 米`) || /最长的一段是 \d+ 米/.test(pageText), { longestSeg });

/* 2a. 改总上限 */
const beforeTotals = await counters();
await page.getByRole("button", { name: /少走点/ }).click();
await page.waitForTimeout(3000);
const afterTotalText = await page.evaluate(() => document.body.innerText);
const afterTotals = await counters();
check("8 改总上限后高德计数不变（0 新增）", afterTotals.total === beforeTotals.total, { before: beforeTotals, after: afterTotals });
check("9 回显了人话结论", /全天走 \d+ 米/.test(afterTotalText), afterTotalText.match(/这条路线[^\n]*/)?.[0] ?? null);
check("10 回显了本次新增调用次数", afterTotalText.includes("本次重解新增高德调用"));
await page.screenshot({ path: path.join(EVIDENCE, "family-real-total.png"), fullPage: false });

/* 2b. 改单段上限 */
const beforeSeg = await counters();
await page.getByRole("button", { name: /一小段/ }).click().catch(() => {});
await page.waitForTimeout(3000);
const afterSegText = await page.evaluate(() => document.body.innerText);
const afterSeg = await counters();
check("11 改单段上限后高德计数不变（0 新增）", afterSeg.total === beforeSeg.total, { before: beforeSeg, after: afterSeg });
check("12 单段请求确实带上了 maxSegmentMeters", resolvePosts.some((b) => typeof b.maxSegmentMeters === "number"), { bodies: resolvePosts.map((b) => ({ w: b.maxWalkMeters, s: b.maxSegmentMeters })) });
check("13 回显里出现单段结论或如实失败说明", /最长一段走 \d+ 米/.test(afterSegText) || /已证实不可行|排不出|取消单段/.test(afterSegText), afterSegText.match(/[^\n]*最长一段[^\n]*|已证实不可行[^\n]*/)?.[0] ?? null);
await page.screenshot({ path: path.join(EVIDENCE, "family-real-segment.png"), fullPage: false });

/* 2c. 不设限：应回到完整方案 */
const beforeFree = await counters();
await page.getByRole("button", { name: /不设限/ }).click().catch(() => {});
await page.waitForTimeout(3000);
const freeText = await page.evaluate(() => document.body.innerText);
const afterFree = await counters();
check("14 不设限后高德计数仍不变", afterFree.total === beforeFree.total, { before: beforeFree, after: afterFree });
check("15 不设限如实写没有设上限", freeText.includes("没有设走路上限") || /全天走 \d+ 米/.test(freeText));

/* ── 3. 无障碍洗手间展示 ─────────────────────────────────── */
const toiletText = freeText;
const hasToiletLine = /无障碍洗手间/.test(toiletText);
check("16 行程卡上展示了无障碍洗手间（若该城有标注点）", hasToiletLine || (report.toilets?.found ?? 0) === 0, {
  found: report.toilets?.found ?? 0,
  nearest: report.toilets?.nearest?.length ?? 0,
});
check("17 无障碍洗手间口径写明不代表整条路线无障碍", !hasToiletLine || toiletText.includes("不代表整条路线无障碍"));

check("18 全程 0 弹窗", dialogs.length === 0, dialogs);

/* ── 4. 手机端 ──────────────────────────────────────────── */
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
await mobile.addInitScript(([k, v]) => { sessionStorage.setItem(k, v); }, [
  "xuxiake.session.route",
  JSON.stringify({ cityName: "杭州", report, usedCategories: report.categories ?? ["自然风光"] }),
]);
await mobile.route("**/*", (route) => {
  const req = route.request();
  if (req.method() === "POST" && /\/api\/resolve/.test(req.url())) return route.continue();
  if (req.method() === "POST") return route.abort();
  try { const h = new URL(req.url()).hostname; if (h === "localhost" || h === "127.0.0.1") return route.continue(); } catch { /* ignore */ }
  return route.abort();
});
const mp = await mobile.newPage();
await mp.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await mp.getByRole("button", { name: "行程与探索", exact: true }).click().catch(() => {});
await mp.waitForTimeout(1200);
const overflow = await mp.evaluate(() => {
  const doc = document.documentElement;
  const nodes = Array.from(document.querySelectorAll('[aria-label="爸妈能走多远"], button')).filter((el) => /走不远|少走点|一小段|不设限/.test(el.textContent ?? ""));
  const visible = nodes.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  return { visible: visible.length, anyOverflow: visible.some((el) => el.getBoundingClientRect().right > doc.clientWidth + 1), pageOverflows: doc.scrollWidth > doc.clientWidth + 1 };
});
check("19 手机端两个面板可见且不横向溢出", overflow.visible > 0 && !overflow.anyOverflow && !overflow.pageOverflows, overflow);
await mp.locator("text=爸妈能走多远").first().scrollIntoViewIfNeeded().catch(() => {});
await mp.waitForTimeout(400);
await mp.screenshot({ path: path.join(EVIDENCE, "family-real-mobile.png"), fullPage: false });

await mobile.close();
await context.close();
await browser.close();

const final = await counters();
check("20 整场结束后高德总新增仅来自那次核验", final.total === afterVerify.total, { afterVerify, final, verifySpent });

const failed = results.filter((r) => !r.pass);
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: true,
  verifySpent,
  resolveCalls: resolvePosts.length,
  resolveBodies: resolvePosts,
  counters: { before, afterVerify, final },
  realItinerary: {
    stops: stops.map((s) => ({ name: s.name, flyaiId: s.flyaiId, flyaiIdFromSource: s.flyaiIdFromSource ?? null })),
    totalWalkMeters: totalWalk,
    longestSegmentMeters: longestSeg,
  },
  toilets: report.toilets ? { found: report.toilets.found, nearest: report.toilets.nearest, newCalls: report.toilets.newCalls } : null,
  blockedExternal,
  dialogs,
  screenshots: ["family-real-total.png", "family-real-segment.png", "family-real-mobile.png"],
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "family-real-accept.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过（核验新增 ${verifySpent}，重解 ${resolvePosts.length} 次，重解阶段新增 ${final.total - afterVerify.total}）`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
