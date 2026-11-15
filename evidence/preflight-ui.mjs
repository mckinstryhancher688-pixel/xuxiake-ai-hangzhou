/**
 * 「出门前先问一句」零付费 UI 验证：三档渲染、选中态、核验后自动重解、失败如实提示、手机不溢出。
 *
 * 全程拦截 /api/resolve 并返回桩结果，其余付费端点一律拦截：本脚本只验证界面与接线，
 * 不代表真实路线或真实重解结果。真实数据验收见 walk-limit-ui-accept.mjs（付费）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { FIXTURE_SNAPSHOT } from "./preflight-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SNAPSHOT_KEY = "xuxiake.session.route";

const CLI = [
  process.env.PLAYWRIGHT_CLI_PACKAGE,
  path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@playwright", "cli", "package.json"),
].filter(Boolean);
function loadPlaywright() {
  for (const candidate of CLI) {
    try { return createRequire(candidate)("playwright"); } catch { /* 下一个 */ }
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

const resolveBodies = [];
let resolveMode = "ok";

function stubOk(body) {
  const limit = body.maxWalkMeters ?? null;
  const segLimit = body.maxSegmentMeters ?? null;
  return {
    ok: true,
    cost: { newAmapCalls: 0 },
    execution: { allowed: true, reason: "桩：满足条件" },
    explanation: {
      totalWalkMeters: 1800,
      limit,
      withinLimit: true,
      longestSegmentMeters: 900,
      segmentLimit: segLimit,
      withinSegmentLimit: segLimit === null || 900 <= segLimit,
      verdict:
        `这条路线全天走 1800 米，在您定的 ${limit} 米以内` +
        (segLimit === null ? "" : `；最长一段走 900 米，在您定的单段 ${segLimit} 米以内`) + "。",
      whyDropped: [{ id: "x", name: "满陇桂雨", text: `保留「满陇桂雨」会走到 2600 米，超出你定的 ${limit} 米，所以这次没排它。` }],
      keptBecauseMust: [],
      withoutLimit: { totalWalkMeters: 2600, stopCount: 4 },
    },
    itinerary: {
      ...FIXTURE_SNAPSHOT.report.itinerary,
      totalWalkMeters: 1800,
      totalWalkMinutes: 30,
      totalMinutes: 50,
    },
    note: "桩",
  };
}
function stubFail() {
  return {
    ok: false,
    code: "hard-conflict",
    reason: "桩：已证实不可行，最短也要 1950 米，超过你定的上限。",
    suggestion: { maxWalkMeters: 2400, stopCount: 3, totalWalkMeters: 2400 },
    cost: { newAmapCalls: 0 },
  };
}

const browser = await chromium.launch({ headless: false, executablePath: EXEC, args: ["--lang=zh-CN"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
await context.route("**/*", async (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "POST" && /\/api\/resolve/.test(url)) {
    const body = JSON.parse(req.postData() ?? "{}");
    resolveBodies.push(body);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(resolveMode === "ok" ? stubOk(body) : stubFail()),
    });
  }
  if (req.method() === "POST" && /\/api\/(verify|route-geometry|agent|plan)/.test(url)) return route.abort();
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1") return route.continue();
  } catch { /* ignore */ }
  return route.abort();
});

const page = await context.newPage();
const dialogs = [];
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1500);

/* 1. 生成前就能看到 */
const firstText = await page.evaluate(() => document.body.innerText);
check("1 生成路线之前就能看到「爸妈大概能走多远」", firstText.includes("爸妈大概能走多远"));
check("1b 三个档位都在", firstText.includes("走不远") && firstText.includes("一般") && firstText.includes("能走"));
check("1c 说明先定就不用生成完再改", firstText.includes("不用生成完再改") || firstText.includes("生成时就直接按它排"));
check("1d 此时没有重解请求", resolveBodies.length === 0, { calls: resolveBodies.length });

/* 2. 选档：只记状态，不发请求 */
await page.getByRole("button", { name: /走不远/ }).click();
await page.waitForTimeout(700);
check("2 档位有选中态", (await page.getByRole("button", { name: /走不远/ }).getAttribute("class") ?? "").includes("border-brand-600"));
check("2b 没有事实集时不发重解", resolveBodies.length === 0, { calls: resolveBodies.length });

/* 3. 注入已核验夹具快照并刷新 */
await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), [SNAPSHOT_KEY, JSON.stringify(FIXTURE_SNAPSHOT)]);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);

const restored = await page.evaluate(() => document.body.innerText);
check("3 刷新后能恢复已核验路线（无崩溃）", !restored.includes("couldn’t load") && restored.includes("桩站点A（夹具）"), { crashed: restored.includes("couldn’t load") });

/* 4. 有路线之后，改走 WalkLimitPanel 的档位（预问区随「生成」按钮一起消失，这是设计如此） */
await page.getByRole("button", { name: /少走点/ }).click().catch(() => {});
await page.waitForTimeout(2500);
check("4 选档后调用 /api/resolve", resolveBodies.length >= 1, { bodies: resolveBodies });

const afterResolve = await page.evaluate(() => document.body.innerText);
check("4b 显示服务端人话回显", /全天走 1800 米/.test(afterResolve), afterResolve.match(/这条路线[^\n]*/)?.[0] ?? null);
check("4c 显示因果说明", afterResolve.includes("满陇桂雨") && /超出你定的/.test(afterResolve));
await page.screenshot({ path: path.join(EVIDENCE, "preflight-desktop.png"), fullPage: false });

/* 4d. 单段上限：要有独立的「一口气最多走多远」一档，且点击会把 maxSegmentMeters 传上去 */
const segText = await page.evaluate(() => document.body.innerText);
check("4d 出现「一口气最多走多远」", segText.includes("一口气最多走多远"));
check("4e 说明写清「总量再短，中间有一段走不动也不行」", segText.includes("中间有一段走不动也不行"));
const segBefore = resolveBodies.length;
await page.getByRole("button", { name: /一小段/ }).click().catch(() => {});
await page.waitForTimeout(2200);
check("4f 点单段档位会把 maxSegmentMeters 传给服务端", resolveBodies.length === segBefore + 1 && typeof resolveBodies.at(-1)?.maxSegmentMeters === "number", resolveBodies.at(-1));

/* 5. 失败分支 */
resolveMode = "fail";
const beforeFail = resolveBodies.length;
await page.getByRole("button", { name: /稍微少点/ }).click().catch(() => {});
await page.waitForTimeout(2500);
const failText = await page.evaluate(() => document.body.innerText);
check("5 切换档位再次重解", resolveBodies.length === beforeFail + 1, { before: beforeFail, after: resolveBodies.length });
check("5b 排不出时如实提示", /已证实不可行|排不出/.test(failText), failText.match(/[^\n]*已证实不可行[^\n]*/)?.[0] ?? null);
check("5c 提示里带真数（米）", /\d+ 米/.test(failText));
check("5d 全程 0 弹窗", dialogs.length === 0, dialogs);

/* 6. 手机端（无快照：看生成前的档位） */
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
await mobile.route("**/*", async (route) => {
  const req = route.request();
  if (req.method() === "POST" && /\/api\/resolve/.test(req.url())) {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stubOk(JSON.parse(req.postData() ?? "{}"))) });
  }
  if (req.method() === "POST" && /\/api\/(verify|route-geometry|agent|plan)/.test(req.url())) return route.abort();
  try {
    const host = new URL(req.url()).hostname;
    if (host === "localhost" || host === "127.0.0.1") return route.continue();
  } catch { /* ignore */ }
  return route.abort();
});
const mpage = await mobile.newPage();
await mpage.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await mpage.waitForTimeout(1200);
const overflow = await mpage.evaluate(() => {
  const doc = document.documentElement;
  const buttons = Array.from(document.querySelectorAll("button")).filter((b) => /走不远|一般|能走/.test(b.textContent ?? ""));
  const visible = buttons.filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  return {
    visibleButtons: visible.length,
    anyOverflow: visible.some((b) => b.getBoundingClientRect().right > doc.clientWidth + 1),
    pageOverflows: doc.scrollWidth > doc.clientWidth + 1,
  };
});
check("6 手机端三档可见且不横向溢出", overflow.visibleButtons >= 3 && !overflow.anyOverflow && !overflow.pageOverflows, overflow);
await mpage.screenshot({ path: path.join(EVIDENCE, "preflight-mobile.png"), fullPage: false });

await mobile.close();
await context.close();
await browser.close();

const failed = results.filter((r) => !r.pass);
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: false,
  fixture: true,
  fixtureNotice: "注入夹具快照并拦截 /api/resolve 返回桩结果；只验证界面与接线，不代表真实路线或真实重解结果。",
  resolveCalls: resolveBodies.length,
  resolveBodies,
  dialogs,
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "preflight-ui.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过（重解请求 ${resolveBodies.length} 次，全部为桩）`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
