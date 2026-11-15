/**
 * 亲情模式「爸妈能走多远」真机 UI 验收。
 *
 * 成本：一次真实核验（单类别，约 27 次高德；命中整链缓存则为 0）。之后所有点击都走事实层重解，0 新增。
 * 跑法：CONFIRM_PAID=yes node evidence/walk-limit-ui-accept.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
if (process.env.CONFIRM_PAID !== "yes") {
  console.error("拒绝运行：本脚本会触发一次真实核验（付费）。需 CONFIRM_PAID=yes 且已获批准。");
  process.exit(2);
}

const CLI_CANDIDATES = [
  process.env.PLAYWRIGHT_CLI_PACKAGE,
  path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@playwright", "cli", "package.json"),
  path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@playwright", "cli", "package.json"),
].filter(Boolean);
function loadPlaywright() {
  for (const c of CLI_CANDIDATES) {
    try { return createRequire(c)("playwright"); } catch { /* next */ }
  }
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
  return { place: j.placeHourlyUsed, walking: j.walkingHourlyUsed, total: j.placeHourlyUsed + j.walkingHourlyUsed };
}

const isLocal = (url) => {
  try { const h = new URL(url).hostname; return h === "localhost" || h === "127.0.0.1"; } catch { return false; }
};

/* 1. 一次真实核验，让事实层就位（这是唯一可能花钱的一步） */
const before = await counters();
const verifyRes = await fetch(BASE + "/api/verify", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cityName: "杭州", categories: ["自然风光"] }),
});
const report = (await verifyRes.json())?.report;
const afterVerify = await counters();
const verifySpent = afterVerify.total - before.total;
check("1 真实核验产出可行行程与事实集", verifyRes.status === 200 && report?.ok === true && Boolean(report?.facts?.factsId), {
  status: verifyRes.status, ok: report?.ok, factsId: report?.facts?.factsId, stops: report?.itinerary?.stops?.length, verifySpent,
});
if (!report?.facts?.factsId) { console.error("没有事实集，无法继续。"); process.exit(1); }

const browser = await chromium.launch({ headless: false, executablePath: EXEC, args: ["--lang=zh-CN"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
let blockedExternal = 0;
const resolvePosts = [];
await context.route("**/*", (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "POST" && /\/api\/resolve/.test(url)) { resolvePosts.push(url); return route.continue(); }
  // 拦截核验与几何/百炼，避免任何额外付费；但要把已核验的快照注入页面
  if (req.method() === "POST" && /\/api\/(verify|route-geometry|agent|plan)/.test(url)) return route.abort();
  if (isLocal(url)) return route.continue();
  blockedExternal += 1;
  return route.abort();
});
// 注入真实报告，让页面直接进入「已核验」状态
await context.addInitScript(([key, value]) => { sessionStorage.setItem(key, value); }, [
  "xuxiake.session.route",
  JSON.stringify({ cityName: "杭州", report, usedCategories: report.categories ?? ["自然风光"] }),
]);

const page = await context.newPage();
const dialogs = [];
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.getByRole("button", { name: "行程与探索", exact: true }).click().catch(() => {});
await page.waitForTimeout(1200);

/* 2. 面板出现 */
const panel = page.getByRole("region", { name: "爸妈能走多远" });
check("2 「爸妈能走多远」面板在行程页可见", await panel.isVisible().catch(() => false));
const bodyText = await page.evaluate(() => document.body.innerText);
check("2b 面板附近写明「改上限不再花钱」", bodyText.includes("改上限不再花钱"));

/* 3. 点「慢慢走」（1.5 公里）：必须走重解端点，且结果如实显示 */
await page.getByRole("button", { name: /少走点/, exact: false }).click();
await page.waitForTimeout(2500);
const afterClickText = await page.evaluate(() => document.body.innerText);
check("3 点击后调用了 /api/resolve（事实层重解）", resolvePosts.length >= 1, { posts: resolvePosts.length });
const hasVerdict = /这条路线全天走 \d+ 米|排不出|不可行|最少/.test(afterClickText);
check("3b 显示了服务端判定的人话结论", hasVerdict, afterClickText.match(/这条路线[^\n]*/)?.[0] ?? null);
check("3c 显示了本次重解新增高德调用次数", afterClickText.includes("本次重解新增高德调用"));
check("3d 显示了复用已实测路段或 0 次", afterClickText.includes("复用已实测路段") || /新增高德调用：0 次/.test(afterClickText));

/* 4. 点「不设限」：应回到完整方案 */
const postsBeforeFree = resolvePosts.length;
await page.getByRole("button", { name: /不设限/ }).click();
await page.waitForTimeout(2500);
const freeText = await page.evaluate(() => document.body.innerText);
check("4 「不设限」同样走重解端点", resolvePosts.length === postsBeforeFree + 1, { before: postsBeforeFree, after: resolvePosts.length });
check("4b 不设限时如实写「没有设走路上限」", freeText.includes("没有设走路上限") || /全天走 \d+ 米/.test(freeText));

/* 5. 计数：整段 UI 操作后高德不得新增 */
const afterUi = await counters();
check("5 全部点击结束后高德计数与核验后一致（0 新增）", afterUi.total === afterVerify.total, { afterVerify, afterUi });
check("5b 没有弹窗", dialogs.length === 0, dialogs);

/* 6. 手机端布局 */
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
await mobile.addInitScript(([key, value]) => { sessionStorage.setItem(key, value); }, [
  "xuxiake.session.route",
  JSON.stringify({ cityName: "杭州", report, usedCategories: report.categories ?? ["自然风光"] }),
]);
await mobile.route("**/*", (route) => {
  const req = route.request();
  if (req.method() === "POST" && /\/api\/(verify|route-geometry|agent|plan)/.test(req.url())) return route.abort();
  if (isLocal(req.url())) return route.continue();
  return route.abort();
});
const mpage = await mobile.newPage();
await mpage.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await mpage.getByRole("button", { name: "行程与探索", exact: true }).click().catch(() => {});
await mpage.waitForTimeout(1000);
await mpage.getByRole("button", { name: /少走点/ }).click();
await mpage.waitForTimeout(2500);
const overflow = await mpage.evaluate(() => {
  const el = document.querySelector('[aria-label="爸妈能走多远"]');
  const doc = document.documentElement;
  return {
    panelFound: Boolean(el),
    panelRight: el ? Math.round(el.getBoundingClientRect().right) : null,
    clientWidth: doc.clientWidth,
    pageOverflows: doc.scrollWidth > doc.clientWidth + 1,
  };
});
check("6 手机端面板不横向溢出且页面无横向滚动", overflow.panelFound && overflow.panelRight <= overflow.clientWidth + 1 && !overflow.pageOverflows, overflow);
await mpage.screenshot({ path: path.join(EVIDENCE, "walk-limit-mobile.png"), fullPage: false });
await mpage.locator('[aria-label="爸妈能走多远"]').scrollIntoViewIfNeeded().catch(() => {});
await mpage.screenshot({ path: path.join(EVIDENCE, "walk-limit-mobile-panel.png"), fullPage: false }).catch(() => {});

const ctx2 = await context;
await page.getByRole("button", { name: /少走点/ }).click().catch(() => {});
await page.waitForTimeout(2000);
await page.locator('[aria-label="爸妈能走多远"]').scrollIntoViewIfNeeded().catch(() => {});
await page.screenshot({ path: path.join(EVIDENCE, "walk-limit-desktop.png"), fullPage: false }).catch(() => {});
await mobile.close();
await ctx2.close();
await browser.close();

const final = await counters();
check("7 整场（含手机端）结束后高德仍无新增", final.total === afterVerify.total, { afterVerify, final });

const failed = results.filter((r) => !r.pass);
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: true,
  verifySpent,
  resolveCalls: resolvePosts.length,
  counters: { before, afterVerify, afterUi, final },
  realStops: (report.itinerary?.stops ?? []).map((s) => ({ name: s.name, flyaiId: s.flyaiId, flyaiIdFromSource: s.flyaiIdFromSource ?? null })),
  blockedExternal,
  dialogs,
  screenshots: ["walk-limit-desktop.png", "walk-limit-mobile.png", "walk-limit-mobile-panel.png"],
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "walk-limit-ui-accept.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过（核验新增 ${verifySpent}，重解调用 ${resolvePosts.length} 次，重解新增高德 ${final.total - afterVerify.total}）`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
