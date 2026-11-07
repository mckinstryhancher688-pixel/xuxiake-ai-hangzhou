/**
 * 飞猪优化① C/D：真实数据在真实 UI 里的证据条验收（零新增付费）。
 * 跑法：先跑 source-evidence-paid-accept.mjs 让整链缓存生效（30 分钟内），
 *       再 node evidence/source-evidence-real-ui.mjs
 *
 * 成本口径（重要）：主界面点「开始核验」后地图还会 POST /api/route-geometry 补折线，那是真实付费，
 * 所以本脚本不点核验按钮。改为：Node 侧做一次整链缓存命中的 POST /api/verify 取回真实报告
 * （跑前跑后比对小时计数，若有任何新增立即中止），再把报告注入 sessionStorage 让 UI 原样恢复；
 * 浏览器内拦截 /api/verify、/api/route-geometry 的一切 POST 与所有外部请求 → 0 付费、地图回退手绘底图。
 * 断言 3 个真实站点（平湖秋月/西湖天地/南宋御街）各亮 ✓已校验 + 查询于、数据可信说明块可见、手机不溢出。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ROUTE_SNAPSHOT_KEY = "xuxiake.session.route";
const REAL_NAMES = ["平湖秋月", "西湖天地", "南宋御街"];
const CATEGORIES = ["自然风光", "文创街区"];

const CLI_CANDIDATES = [
  process.env.PLAYWRIGHT_CLI_PACKAGE,
  path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@playwright", "cli", "package.json"),
  path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@playwright", "cli", "package.json"),
  "/usr/local/lib/node_modules/@playwright/cli/package.json",
  "/usr/lib/node_modules/@playwright/cli/package.json",
].filter(Boolean);
function loadPlaywright() {
  for (const candidate of CLI_CANDIDATES) {
    try { return createRequire(candidate)("playwright"); } catch { /* 下一个 */ }
  }
  return createRequire(import.meta.url)("playwright");
}
const { chromium } = loadPlaywright();
const BROWSER_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROME,
  path.join(os.homedir(), "AppData", "Local", "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe"),
  path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1228", "chrome-linux", "chrome"),
].filter(Boolean);
const EXEC = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${JSON.stringify(detail)}` : ""}`);
}
async function counters() {
  const r = await fetch(BASE + "/api/verify", { cache: "no-store" });
  const j = await r.json();
  return { place: j.placeHourlyUsed, walking: j.walkingHourlyUsed };
}
const isLocal = (url) => {
  try { const h = new URL(url).hostname; return h === "localhost" || h === "127.0.0.1" || h === new URL(BASE).hostname; } catch { return false; }
};

const before = await counters();
// 取回真实报告：必须整链缓存命中（0 新增）。有任何新增立即中止，不再往下花钱。
const vr = await fetch(BASE + "/api/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cityName: "杭州", categories: CATEGORIES }) });
const report = (await vr.json())?.report ?? null;
const afterFetch = await counters();
const fetchSpent = (afterFetch.place - before.place) + (afterFetch.walking - before.walking);
check("取回真实报告为整链缓存命中（0 新增高德）", vr.status === 200 && report?.ok === true && fetchSpent === 0, { status: vr.status, ok: report?.ok, fetchSpent });
if (fetchSpent !== 0 || !report?.itinerary) {
  console.error("取报告产生了新增付费或无行程，中止 UI 验收（不再花钱）。");
  fs.writeFileSync(path.join(EVIDENCE, "source-evidence-real-ui.json"), JSON.stringify({ checkedAt: new Date().toISOString(), aborted: true, fetchSpent, before, afterFetch, checks: results }, null, 2));
  process.exit(1);
}
const snapshot = { cityName: "杭州", report, usedCategories: report.categories ?? CATEGORIES };

const browser = await chromium.launch({ headless: false, executablePath: EXEC, args: ["--lang=zh-CN"] });
async function runViewport(label, viewport, mobile) {
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  let blockedExternal = 0;
  let blockedPaidPosts = 0;
  await context.addInitScript(([key, value]) => { sessionStorage.setItem(key, value); }, [ROUTE_SNAPSHOT_KEY, JSON.stringify(snapshot)]);
  await context.route("**/*", (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "POST" && (/\/api\/verify/.test(url) || /\/api\/route-geometry/.test(url) || /\/api\/agent/.test(url) || /\/api\/plan/.test(url))) { blockedPaidPosts += 1; return route.abort(); }
    if (isLocal(url)) return route.continue();
    blockedExternal += 1; // 只计数，绝不记录外部 URL
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  if (mobile) await page.getByRole("button", { name: "行程与探索", exact: true }).click();
  await page.getByText("✓已校验", { exact: true }).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);

  const bodyText = await page.evaluate(() => document.body.innerText);
  const checkedCount = await page.getByText("✓已校验", { exact: true }).count();
  const namesPresent = REAL_NAMES.every((n) => bodyText.includes(n));
  const timePresent = bodyText.includes("查询于");
  const trustVisible = await page.getByRole("region", { name: "数据可信说明" }).isVisible().catch(() => bodyText.includes("数据可信说明"));
  check(`${label}：3 个真实站点都在行程里`, namesPresent, { names: REAL_NAMES });
  check(`${label}：✓已校验 点亮数 = 3（真实来源校验通过）`, checkedCount === 3, { checkedCount });
  check(`${label}：证据条带紧凑查询时间（查询于 …）`, timePresent);
  check(`${label}：数据可信说明块可见`, Boolean(trustVisible));
  if (mobile) {
    const overflow = await page.evaluate(() => {
      const bars = Array.from(document.querySelectorAll("span")).filter((s) => /✓已校验|未校验|来源 FlyAI/.test(s.textContent ?? ""));
      const visible = bars.filter((s) => { const r = s.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const doc = document.documentElement;
      return { visibleBars: visible.length, anyBarOverflows: visible.some((s) => s.getBoundingClientRect().right > doc.clientWidth + 1), pageOverflows: doc.scrollWidth > doc.clientWidth + 1 };
    });
    check("手机端：可见证据条不横向溢出且页面整体无横向滚动", overflow.visibleBars > 0 && !overflow.anyBarOverflows && !overflow.pageOverflows, overflow);
  }
  check(`${label}：浏览器内 0 次付费 POST（核验/几何/百炼/协商全拦截）`, blockedPaidPosts === 0, { blockedPaidPosts });
  await page.getByText("✓已校验", { exact: true }).first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(EVIDENCE, `source-evidence-real-${mobile ? "mobile" : "desktop"}.png`), fullPage: false });
  await context.close();
  return { blockedExternal, blockedPaidPosts };
}

const desktop = await runViewport("桌面端", { width: 1440, height: 900 }, false);
const mobile = await runViewport("手机端", { width: 390, height: 844 }, true);
await browser.close();

const after = await counters();
check("全程高德小时计数不变（取报告缓存命中 + 浏览器 0 付费）", after.place === before.place && after.walking === before.walking, { before, after });

const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: false,
  note: "真实核验报告经整链缓存命中取回后注入 sessionStorage，UI 原样恢复；浏览器拦截一切付费 POST 与外部请求，地图回退手绘底图。仅验证真实证据条/说明块与手机布局，零新增付费。",
  realNames: REAL_NAMES,
  counters: { before, after },
  fetchSpent,
  blockedExternal: { desktop: desktop.blockedExternal, mobile: mobile.blockedExternal },
  blockedPaidPosts: { desktop: desktop.blockedPaidPosts, mobile: mobile.blockedPaidPosts },
  total: results.length,
  passed: results.length - results.filter((r) => !r.pass).length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "source-evidence-real-ui.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过`);
process.exit(results.some((r) => !r.pass) ? 1 : 0);