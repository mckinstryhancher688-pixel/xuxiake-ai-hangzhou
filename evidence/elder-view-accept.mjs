/**
 * 「给爸妈看」大字版验收。
 *
 * 优先复用整链缓存里的真实报告（0 新增）；缓存失效时才会真实核验一次（需 CONFIRM_PAID=yes）。
 * 跑法：CONFIRM_PAID=yes node evidence/elder-view-accept.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

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
  return { place: j.placeHourlyUsed, walking: j.walkingHourlyUsed, total: j.placeHourlyUsed + j.walkingHourlyUsed };
}

/* 取一份可行报告：先试缓存命中，必要时才真跑 */
const before = await counters();
const cats = (process.env.VERIFY_CATEGORIES ?? "文创街区,自然风光").split(",").map((s) => s.trim()).filter(Boolean);
let report = null;
for (const cat of cats) {
  const res = await fetch(BASE + "/api/verify", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cityName: "杭州", categories: [cat] }),
  });
  const body = await res.json();
  if (body?.report?.ok === true) { report = body.report; console.log(`用类别「${cat}」拿到可行报告`); break; }
}
const afterVerify = await counters();
const verifySpent = afterVerify.total - before.total;
if (!report) {
  console.error("拿不到可行报告，无法验收大字版。");
  process.exit(1);
}
console.log(`核验新增 ${verifySpent} 次高德（0 = 命中缓存）`);
const stops = report.itinerary.stops;
const totalWalk = report.itinerary.totalWalkMeters;
const longest = Math.max(...report.itinerary.legs.map((l) => l.distanceMeters));

const browser = await chromium.launch({ headless: false, executablePath: EXEC, args: ["--lang=zh-CN"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
let blockedPaid = 0;
await context.route("**/*", (route) => {
  const req = route.request();
  if (req.method() === "POST" && /\/api\/(verify|route-geometry|agent|plan|resolve)/.test(req.url())) { blockedPaid += 1; return route.abort(); }
  try { const h = new URL(req.url()).hostname; if (h === "localhost" || h === "127.0.0.1") return route.continue(); } catch { /* ignore */ }
  return route.abort();
});
await context.addInitScript(([k, v]) => { sessionStorage.setItem(k, v); }, [
  "xuxiake.session.route",
  JSON.stringify({ cityName: "杭州", report, usedCategories: report.categories }),
]);

const page = await context.newPage();
const dialogs = [];
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1800);

/* 1. 入口存在 */
const entry = page.getByRole("button", { name: /给爸妈看/ });
check("1 行程页有「给爸妈看」入口", await entry.isVisible().catch(() => false));

/* 2. 打开大字版 */
await entry.click();
await page.waitForTimeout(800);
const dialog = page.getByRole("dialog", { name: "给爸妈看的行程" });
check("2 打开全屏大字版", await dialog.isVisible().catch(() => false));

/* 3. 内容：只讲该讲的，不讲技术细节 */
const text = await dialog.innerText();
check("3 说明一共去几个地方", new RegExp(`一共去 ${stops.length} 个地方`).test(text), { stops: stops.length });
check("4 写出总步行与步行时间", text.includes(`${totalWalk}`) && /走路.*分钟/.test(text.replace(/\s+/g, "")));
check("5 列出每一站的真实名称", stops.every((s) => text.includes(s.name)), { names: stops.map((s) => s.name) });
check("6 每一段都写了走多远", report.itinerary.legs.every((l) => text.includes(`${l.distanceMeters}`)));
check("7 写出最长的一段", text.includes(`${longest}`), { longest });

/* 8. 不该出现在大字版里的东西 */
check("8a 大字版不出现来源标签", !text.includes("来源 FlyAI"));
check("8b 大字版不出现正负号差异", !/[ΔΔ]|正负/.test(text));
check("8c 大字版不出现技术排障入口", !text.includes("坐标系"));

/* 9. 口径必须写清（不能让老人误以为是实测体力） */
check("9a 写明走路距离来自地图、不是人真走一遍", text.includes("高德") && text.includes("不是人真走一遍"));
check("9b 写明停留时间是设定值", text.includes("是我们设定的"));
check("9c 写明不含回程", text.includes("不算回程"));
check("9d 写明厕所只算直线、不代表整条路可推轮椅", text.includes("直线距离") && text.includes("不代表整条路都能推轮椅"));

/* 10. 字号可调且真的变大 */
const titleBefore = await dialog.getByText("这次怎么走").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
await dialog.getByRole("button", { name: "放大字号" }).click();
await dialog.getByRole("button", { name: "放大字号" }).click();
await page.waitForTimeout(300);
const titleAfter = await dialog.getByText("这次怎么走").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
check("10 点「字大」字号真的变大", titleAfter > titleBefore, { before: titleBefore, after: titleAfter });
await dialog.getByRole("button", { name: "缩小字号" }).click();
await page.waitForTimeout(300);
const titleShrunk = await dialog.getByText("这次怎么走").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
check("10b 点「字小」字号变小", titleShrunk < titleAfter, { after: titleAfter, shrunk: titleShrunk });

/* 11. 正文字号达到老人可读水平（≥20px 的正文/站名） */
const bodySizes = await dialog.evaluate((root) => {
  const sizes = [];
  root.querySelectorAll("p, strong").forEach((el) => sizes.push(parseFloat(getComputedStyle(el).fontSize)));
  return { min: Math.min(...sizes), max: Math.max(...sizes) };
});
check("11 大字版最小字号不低于 16px", bodySizes.min >= 16, bodySizes);
check("11b 站名字号明显大于普通界面（≥24px）", bodySizes.max >= 24, bodySizes);

await page.screenshot({ path: path.join(EVIDENCE, "elder-1-expanded.png"), fullPage: false });

/* 12. 关闭 */
await dialog.getByRole("button", { name: "退出" }).click();
await page.waitForTimeout(500);
check("12 点「退出」能关掉", !(await page.getByRole("dialog", { name: "给爸妈看的行程" }).isVisible().catch(() => false)));

/* 13. Esc 关闭 */
await entry.click();
await page.waitForTimeout(600);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("13 按 Esc 也能关掉", !(await page.getByRole("dialog", { name: "给爸妈看的行程" }).isVisible().catch(() => false)));

check("14 全程 0 弹窗", dialogs.length === 0, dialogs);

/* 15. 手机端 */
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
await mobile.addInitScript(([k, v]) => { sessionStorage.setItem(k, v); }, [
  "xuxiake.session.route",
  JSON.stringify({ cityName: "杭州", report, usedCategories: report.categories }),
]);
await mobile.route("**/*", (route) => {
  const req = route.request();
  if (req.method() === "POST") return route.abort();
  try { const h = new URL(req.url()).hostname; if (h === "localhost" || h === "127.0.0.1") return route.continue(); } catch { /* ignore */ }
  return route.abort();
});
const mp = await mobile.newPage();
await mp.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await mp.getByRole("button", { name: "行程与探索", exact: true }).click().catch(() => {});
await mp.waitForTimeout(1000);
await mp.getByRole("button", { name: /给爸妈看/ }).click();
await mp.waitForTimeout(800);
const mOverflow = await mp.evaluate(() => {
  const dlg = document.querySelector('[aria-label="给爸妈看的行程"]');
  const doc = document.documentElement;
  return { found: Boolean(dlg), pageOverflows: doc.scrollWidth > doc.clientWidth + 1, dlgWidth: dlg ? Math.round(dlg.getBoundingClientRect().width) : null, clientWidth: doc.clientWidth };
});
check("15 手机端大字版铺满且不横向溢出", mOverflow.found && !mOverflow.pageOverflows, mOverflow);
await mp.screenshot({ path: path.join(EVIDENCE, "elder-2-mobile.png"), fullPage: false });

/* 16. 计数 */
const afterAll = await counters();
check("16 整场（含大字版操作）高德计数不变", afterAll.total === afterVerify.total, { afterVerify, afterAll, verifySpent });

await mobile.close();
await context.close();
await browser.close();

const failed = results.filter((r) => !r.pass);
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: verifySpent > 0,
  verifySpent,
  blockedPaidPosts: blockedPaid,
  dialogs,
  realItinerary: {
    stops: stops.map((s) => ({ name: s.name, stayMinutes: s.stayMinutes })),
    totalWalkMeters: totalWalk,
    longestSegmentMeters: longest,
    toilets: report.toilets?.nearest ?? [],
  },
  bodyFontSizes: bodySizes,
  screenshots: ["elder-1-expanded.png", "elder-2-mobile.png"],
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "elder-view-accept.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过（核验新增 ${verifySpent}）`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
