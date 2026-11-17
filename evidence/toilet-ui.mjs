/**
 * 沿途无障碍洗手间的零付费 UI 验证：有数据显示、没数据不显示、口径说明明确、手机不溢出。
 *
 * 注入夹具快照（带 toilets），拦截一切 POST：只验证界面，不代表真实路线验收。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { FIXTURE_SNAPSHOT } from "./preflight-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const SNAPSHOT_KEY = "xuxiake.session.route";

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

async function openWith(snapshot) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
  await context.addInitScript(([k, v]) => { sessionStorage.setItem(k, v); }, [SNAPSHOT_KEY, JSON.stringify(snapshot)]);
  let blockedPaid = 0;
  await context.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "POST") { blockedPaid += 1; return route.abort(); }
    try {
      const host = new URL(req.url()).hostname;
      if (host === "localhost" || host === "127.0.0.1") return route.continue();
    } catch { /* ignore */ }
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "行程与探索", exact: true }).click().catch(() => {});
  await page.waitForTimeout(1000);
  return { context, page, blockedPaid: () => blockedPaid };
}

const browser = await chromium.launch({ headless: false, executablePath: EXEC, args: ["--lang=zh-CN"] });

/* 1. 有数据 */
const a = await openWith(FIXTURE_SNAPSHOT);
const textA = await a.page.evaluate(() => document.body.innerText);
check("1 有数据时显示洗手间标签", textA.includes("无障碍洗手间"));
check("1b 显示直线距离与名称", /无障碍洗手间\(夹具\).*直线 120 米/.test(textA.replace(/\s+/g, " ")), textA.match(/无障碍洗手间[^\n]*/)?.[0] ?? null);
check("1c 口径说明写明「直线距离、不是步行距离」", textA.includes("直线距离") && textA.includes("不是步行距离"));
check("1d 口径说明写明「不代表整条路线无障碍」", textA.includes("不代表整条路线无障碍"));
check("1e 口径说明写明「不代表当天开放」", textA.includes("不代表当天开放"));
check("1f 缓存命中时注明未新增高德调用", textA.includes("未新增高德调用"));
check("1g 只有第一站有；第二站不显示", (textA.match(/无障碍洗手间/g) ?? []).length < 6, { occurrences: (textA.match(/无障碍洗手间/g) ?? []).length });
await a.page.screenshot({ path: path.join(EVIDENCE, "toilet-desktop.png"), fullPage: false });

/* 2. 没数据：整块不出现，不留空壳 */
const noToiletSnapshot = JSON.parse(JSON.stringify(FIXTURE_SNAPSHOT));
delete noToiletSnapshot.report.toilets;
const b = await openWith(noToiletSnapshot);
const textB = await b.page.evaluate(() => document.body.innerText);
check("2 没有洗手间数据时不显示该标签", !textB.includes("无障碍洗手间"));
check("2b 也不留下口径说明空壳", !textB.includes("不代表整条路线无障碍"));
check("2c 页面仍正常显示行程", textB.includes("桩站点A（夹具）"));

/* 3. 有查询但全部落空：仍不显示标签（不写「附近有」含糊话） */
const emptySnapshot = JSON.parse(JSON.stringify(FIXTURE_SNAPSHOT));
emptySnapshot.report.toilets = { ...emptySnapshot.report.toilets, found: 0, nearest: [], anchorsWithoutToilet: ["湖滨公园（起点）", "桩站点A（夹具）", "桩站点B（夹具）"] };
const c = await openWith(emptySnapshot);
const textC = await c.page.evaluate(() => document.body.innerText);
check("3 查询结果为空时不虚构洗手间", !textC.includes("无障碍洗手间") && !/无障碍洗手间[^\n]*直线/.test(textC), { hasTag: textC.includes("无障碍洗手间") });
check("3b 也不出现口径说明", !textC.includes("不代表整条路线无障碍"));

/* 4. 手机端不溢出 */
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
await mobile.addInitScript(([k, v]) => { sessionStorage.setItem(k, v); }, [SNAPSHOT_KEY, JSON.stringify(FIXTURE_SNAPSHOT)]);
await mobile.route("**/*", (route) => {
  const req = route.request();
  if (req.method() === "POST") return route.abort();
  try {
    const host = new URL(req.url()).hostname;
    if (host === "localhost" || host === "127.0.0.1") return route.continue();
  } catch { /* ignore */ }
  return route.abort();
});
const mp = await mobile.newPage();
await mp.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await mp.waitForTimeout(1200);
await mp.getByRole("button", { name: "行程与探索", exact: true }).click().catch(() => {});
await mp.waitForTimeout(1000);
const overflow = await mp.evaluate(() => {
  const doc = document.documentElement;
  const chips = Array.from(document.querySelectorAll("span")).filter((s) => /无障碍洗手间/.test(s.textContent ?? ""));
  const visible = chips.filter((s) => { const r = s.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  return {
    visibleChips: visible.length,
    anyOverflow: visible.some((s) => s.getBoundingClientRect().right > doc.clientWidth + 1),
    pageOverflows: doc.scrollWidth > doc.clientWidth + 1,
  };
});
check("4 手机端洗手间标签可见且不横向溢出", overflow.visibleChips > 0 && !overflow.anyOverflow && !overflow.pageOverflows, overflow);
await mp.locator("text=无障碍洗手间").first().scrollIntoViewIfNeeded().catch(() => {});
await mp.waitForTimeout(400);
await mp.screenshot({ path: path.join(EVIDENCE, "toilet-mobile.png"), fullPage: false });

const totalBlocked = a.blockedPaid() + b.blockedPaid() + c.blockedPaid();
check("5 全程 0 次付费 POST", totalBlocked === 0, { blocked: totalBlocked });

await mobile.close();
await a.context.close();
await b.context.close();
await c.context.close();
await browser.close();

const failed = results.filter((r) => !r.pass);
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: false,
  fixture: true,
  fixtureNotice: "注入夹具快照；只验证洗手间标签与口径说明的渲染，不代表真实路线或真实洗手间数据。",
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "toilet-ui.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过`);
for (const f of failed) console.log(`未通过：${f.name}`);
process.exit(failed.length ? 1 : 0);
