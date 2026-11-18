/**
 * 亲情版真机端到端验收（T4，付费）：按新界面走一遍真实流程。
 *
 *   首页选「1 小时」→ 点「生成我的路线」（一次真实核验）→ 核验后自动按 60 分钟重排
 *   → 调整页依次改 30 分钟 / 1.5 小时 / 不确定、每站停留 60 / 15 分钟 → 每次重排 0 新增高德调用
 *   → 地图是高德真实底图 → 大字版按分钟说话 → 手机端不溢出。
 *
 * 成本上限：一次真实核验（文创街区单类别）约 27 次高德 + 1 次无障碍洗手间查询 + 1 次飞猪 search-poi。
 * 之后所有改动只走 /api/resolve（纯本地重算）。百炼（讲解、读一句话）与双人协商的请求一律拦截，0 次。
 * 脚本前后读服务端计数，把实际花费写进 evidence/family-real-accept.json。
 *
 * 跑法（服务需已用最新代码 build，并以 -H 127.0.0.1 启动）：
 *   CONFIRM_PAID=yes node evidence/family-real-accept.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
/** 高德新增调用超过这个数就判失败（预算 ~28，留一点余量给重试） */
const AMAP_BUDGET = 40;
const FLYAI_BUDGET = 1;

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
  const [verify, discover, understand, agent] = await Promise.all(
    ["/api/verify", "/api/discover", "/api/understand", "/api/agent"].map(async (p) => {
      try { return await (await fetch(BASE + p, { cache: "no-store" })).json(); } catch { return {}; }
    }),
  );
  return {
    amapPlace: verify.placeHourlyUsed ?? null,
    amapWalking: verify.walkingHourlyUsed ?? null,
    amap: (verify.placeHourlyUsed ?? 0) + (verify.walkingHourlyUsed ?? 0),
    flyai: discover.hourlyCallsUsed ?? null,
    understand: understand.modelCalls ?? null,
    agentTurns: agent?.counters?.totalTurns ?? agent?.totalTurns ?? null,
    pid: verify.pid ?? null,
  };
}

const sumWalk = (itinerary) => itinerary.legs.reduce((sum, leg) => sum + leg.durationMinutes, 0);

const before = await counters();
console.log(`起始计数：${JSON.stringify(before)}`);

const browser = await chromium.launch({ headless: process.env.HEADED !== "1", executablePath: EXEC, args: ["--lang=zh-CN"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });

const blockedPosts = [];
const resolveLog = [];
let verifyPosts = 0;
await context.route("**/*", (route) => {
  const req = route.request();
  const url = req.url();
  if (req.method() === "POST" && /\/api\/(agent|understand|plan|discover)/.test(url)) {
    blockedPosts.push(new URL(url).pathname);
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "验收脚本拦截：本次不调用百炼、协商与独立的飞猪发现" }) });
  }
  if (req.method() === "POST" && /\/api\/verify/.test(url)) verifyPosts += 1;
  return route.continue();
});

const page = await context.newPage();
const dialogs = [];
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
page.on("response", async (response) => {
  if (response.request().method() !== "POST" || !/\/api\/resolve/.test(response.url())) return;
  try {
    const body = await response.json();
    resolveLog.push({ request: JSON.parse(response.request().postData() ?? "{}"), body });
  } catch { /* ignore */ }
});

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1500);

/* ── 1. 首页选「1 小时」，点生成：一次真实核验 ── */
await page.getByRole("button", { name: /^1 小时/ }).click();
await page.getByRole("button", { name: /生成我的路线/ }).click();
console.log("已点「生成我的路线」，等待真实核验……");
await page.waitForFunction(() => !document.body.innerText.includes("正在实测路线"), null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(4000);

const snapshot = await page.evaluate(() => sessionStorage.getItem("xuxiake.session.route"));
const report = snapshot ? JSON.parse(snapshot).report : null;
const afterVerify = await counters();
const verifySpent = afterVerify.amap - before.amap;
const flyaiSpent = (afterVerify.flyai ?? 0) - (before.flyai ?? 0);

check("1 真实核验产出可行行程（至少 2 站）", report?.ok === true && (report?.itinerary?.stops?.length ?? 0) >= 2, {
  ok: report?.ok, stops: report?.itinerary?.stops?.map((s) => s.name), error: report?.error ?? null, insufficiency: report?.insufficiency?.slice?.(0, 80) ?? null,
});
check(`2 核验花费在预算内：高德 ≤ ${AMAP_BUDGET}、飞猪 ≤ ${FLYAI_BUDGET}`, verifySpent <= AMAP_BUDGET && flyaiSpent <= FLYAI_BUDGET, { verifySpent, flyaiSpent, verifyPosts });

if (report?.ok !== true) {
  console.log("\n这次真实数据没能排出可行路线，无法继续后面的步骤。这属于产品如实失败，不是代码缺陷。");
  const summary = { checkedAt: new Date().toISOString(), baseUrl: BASE, paid: true, outcome: "verify-not-feasible", verifySpent, flyaiSpent, counters: { before, afterVerify }, total: results.length, passed: results.filter((r) => r.pass).length, checks: results };
  fs.writeFileSync(path.join(EVIDENCE, "family-real-accept.json"), JSON.stringify(summary, null, 2));
  await browser.close();
  process.exit(1);
}

const rawItinerary = report.itinerary;
check("3 核验路线的步行分钟 = 高德逐段实测分钟之和", rawItinerary.totalWalkMinutes === sumWalk(rawItinerary), { total: rawItinerary.totalWalkMinutes, sum: sumWalk(rawItinerary) });
check("4 每段步行都带真实折线（不是两点直线）", rawItinerary.legs.every((leg) => Array.isArray(leg.polyline) && leg.polyline.length > 2), rawItinerary.legs.map((leg) => leg.polyline?.length ?? 0));

/* ── 2. 核验后按首页答的 60 分钟自动重排 ── */
const auto = resolveLog[0];
check("5 核验后自动按 60 分钟重排恰好 1 次", resolveLog.length === 1 && auto?.request?.maxWalkMinutes === 60, resolveLog.map((r) => r.request));
if (auto?.body?.ok) {
  const it = auto.body.itinerary;
  check("5b 自动重排 0 新增高德调用，步行 ≤ 60 分钟且等于逐段之和", auto.body.cost?.newAmapCalls === 0 && it.totalWalkMinutes <= 60 && it.totalWalkMinutes === sumWalk(it), { newAmapCalls: auto.body.cost?.newAmapCalls, walk: it.totalWalkMinutes, sum: sumWalk(it) });
} else {
  check("5b 60 分钟排不出时如实说明（不是静默退回超限路线）", typeof auto?.body?.reason === "string", auto?.body?.reason?.slice?.(0, 120) ?? null);
}

/* ── 3. 地图：高德真实底图 ── */
const mapState = await page.evaluate(() => ({
  amap: Boolean(window.AMap),
  text: document.body.innerText,
}));
check("6 地图是高德 JS API 真实底图（不是手绘示意）", mapState.amap && mapState.text.includes("底图：高德 JS API 2.0 真实地图") && !mapState.text.includes("INVALID_USER_DOMAIN"), { amap: mapState.amap });
check("6b 地图上标的是真实站点名", report.itinerary.stops.slice(0, 2).every((s) => mapState.text.includes(s.name)));
check("6c 页面上没有「少走一点」按钮（D1）", (await page.getByRole("button", { name: /少走一点/ }).count()) === 0);
await page.screenshot({ path: path.join(EVIDENCE, "family-real-route.png"), fullPage: false });

/* ── 4. 调整页：改分钟、改停留，每次 0 新增高德调用 ── */
await page.getByRole("tab", { name: "调整" }).click();
await page.waitForTimeout(800);
const walkGroup = page.getByRole("group", { name: "全程步行上限" });
const stayGroup = page.getByRole("group", { name: "每站停留多久" });

const steps = [
  { label: "步行 30 分钟", click: () => walkGroup.getByRole("button", { name: /^30 分钟/ }).click(), expect: { minutes: 30, stay: 30 } },
  { label: "步行 1.5 小时", click: () => walkGroup.getByRole("button", { name: /^1\.5 小时/ }).click(), expect: { minutes: 90, stay: 30 } },
  { label: "每站停留 60 分钟", click: () => stayGroup.getByRole("button", { name: "60 分钟" }).click(), expect: { minutes: 90, stay: 60 } },
  { label: "每站停留 15 分钟", click: () => stayGroup.getByRole("button", { name: "15 分钟" }).click(), expect: { minutes: 90, stay: 15 } },
  { label: "步行 不确定", click: () => walkGroup.getByRole("button", { name: /^不确定/ }).click(), expect: { minutes: null, stay: 15 } },
];
const stepRecords = [];
for (const step of steps) {
  const c0 = await counters();
  const n0 = resolveLog.length;
  await step.click();
  await page.waitForFunction(() => !document.body.innerText.includes("正在用已实测的路段重新排"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const c1 = await counters();
  const entry = resolveLog[n0];
  const body = entry?.body;
  const req = entry?.request ?? {};
  const record = { step: step.label, request: req, ok: body?.ok ?? null, amapDelta: c1.amap - c0.amap, newAmapCalls: body?.cost?.newAmapCalls ?? null };
  if (body?.ok) {
    const it = body.itinerary;
    const stay = req.stayMinutes;
    record.stops = it.stops.map((s) => s.name);
    record.walk = it.totalWalkMinutes;
    record.total = it.totalMinutes;
    record.bill = { walk: it.totalWalkMinutes, stay: it.totalStayMinutes, buffer: it.bufferMinutes, stopCount: it.stops.length };
    check(`7 ${step.label}：恰好 1 次重排，请求参数正确`, resolveLog.length === n0 + 1 && (req.maxWalkMinutes ?? null) === step.expect.minutes && req.stayMinutes === step.expect.stay, req);
    check(`7b ${step.label}：0 新增高德调用（服务端计数前后一致）`, record.amapDelta === 0 && record.newAmapCalls === 0, { amapDelta: record.amapDelta, newAmapCalls: record.newAmapCalls });
    check(`7c ${step.label}：步行分钟 = 逐段实测之和${step.expect.minutes ? `，且 ≤ ${step.expect.minutes}` : ""}`, it.totalWalkMinutes === sumWalk(it) && (step.expect.minutes === null || it.totalWalkMinutes <= step.expect.minutes), { walk: it.totalWalkMinutes, sum: sumWalk(it) });
    check(`7d ${step.label}：账单 合计 = 步行 + 站数 × ${stay} + 缓冲 20，且不超过 240`, it.stops.every((s) => s.stayMinutes === stay) && it.totalStayMinutes === stay * it.stops.length && it.bufferMinutes === 20 && it.totalMinutes === it.totalWalkMinutes + it.totalStayMinutes + 20 && it.totalMinutes <= 240, record.bill);
    const billText = await page.getByTestId("resolve-bill").innerText().catch(() => "");
    check(`7e ${step.label}：界面账单与服务端数字一致`, billText.includes(`合计 ${it.totalMinutes} / 240 分钟`) && billText.includes(`${it.stops.length} 站 × ${stay} 分钟 = ${it.totalStayMinutes} 分钟`), billText);
  } else {
    check(`7 ${step.label}：排不出时如实说明，且 0 新增高德调用`, typeof body?.reason === "string" && record.amapDelta === 0, { reason: body?.reason?.slice?.(0, 160) ?? null, amapDelta: record.amapDelta });
    record.reason = body?.reason ?? null;
  }
  stepRecords.push(record);
}
await page.screenshot({ path: path.join(EVIDENCE, "family-real-adjust.png"), fullPage: false });

/* ── 5. 大字版：按分钟说话、字够大 ── */
await page.getByRole("tab", { name: "行程" }).click();
await page.waitForTimeout(600);
await page.getByRole("button", { name: /给爸妈看/ }).click();
await page.waitForTimeout(800);
const elder = await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return null;
  const sizes = Array.from(dialog.querySelectorAll("p")).map((p) => parseFloat(getComputedStyle(p).fontSize)).filter((n) => n > 0);
  return { text: dialog.innerText, minFont: Math.min(...sizes), maxFont: Math.max(...sizes) };
});
check("8 大字版打开，写的是去几个地方、走多少分钟", Boolean(elder) && /一共去 \d+ 个地方/.test(elder.text) && /大约 \d+ 分钟/.test(elder.text), elder?.text?.slice(0, 120) ?? null);
check("8b 大字版正文最小字号 ≥ 18px", Boolean(elder) && elder.minFont >= 18, elder && { min: elder.minFont, max: elder.maxFont });
check("8c 大字版不出现米数上限句式", Boolean(elder) && !/说好的 \d+ 米/.test(elder.text));
await page.screenshot({ path: path.join(EVIDENCE, "family-real-elder.png"), fullPage: false });
await page.getByRole("button", { name: "退出" }).click().catch(() => {});

/* ── 6. 手机端：同一份真实路线，调整页与大字版都不横向溢出 ── */
const routeSnapshot = await page.evaluate(() => sessionStorage.getItem("xuxiake.session.route"));
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
await mobile.addInitScript((value) => { sessionStorage.setItem("xuxiake.session.route", value); }, routeSnapshot);
await mobile.route("**/*", (route) => {
  const req = route.request();
  if (req.method() === "POST" && /\/api\/(agent|understand|plan|discover|verify)/.test(req.url())) {
    blockedPosts.push(`mobile:${new URL(req.url()).pathname}`);
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  }
  return route.continue();
});
const mp = await mobile.newPage();
await mp.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await mp.waitForTimeout(2000);
await mp.getByRole("button", { name: "行程与探索", exact: true }).click().catch(() => {});
await mp.getByRole("tab", { name: "调整" }).click().catch(() => {});
await mp.waitForTimeout(800);
const mobileAdjust = await mp.evaluate(() => {
  const doc = document.documentElement;
  const region = document.querySelector('[aria-label="爸妈能走多久"]');
  const controls = region ? Array.from(region.querySelectorAll("button")).filter((b) => b.getBoundingClientRect().width > 0) : [];
  return {
    controls: controls.length,
    anyOverflow: controls.some((b) => b.getBoundingClientRect().right > doc.clientWidth + 1),
    pageOverflows: doc.scrollWidth > doc.clientWidth + 1,
    chars: region ? region.innerText.replace(/\s+/g, "").length : -1,
  };
});
check("9 手机端调整页：步行 4 档 + 停留 4 档都可见且不横向溢出", mobileAdjust.controls >= 8 && !mobileAdjust.anyOverflow && !mobileAdjust.pageOverflows, mobileAdjust);
await mp.screenshot({ path: path.join(EVIDENCE, "family-real-mobile-adjust.png"), fullPage: false });
await mp.getByRole("tab", { name: "行程" }).click().catch(() => {});
await mp.waitForTimeout(500);
await mp.getByRole("button", { name: /给爸妈看/ }).click().catch(() => {});
await mp.waitForTimeout(800);
const mobileElder = await mp.evaluate(() => {
  const doc = document.documentElement;
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return null;
  const sizes = Array.from(dialog.querySelectorAll("p")).map((p) => parseFloat(getComputedStyle(p).fontSize)).filter((n) => n > 0);
  const buttons = Array.from(dialog.querySelectorAll("button")).filter((b) => b.getBoundingClientRect().width > 0);
  return {
    minFont: Math.min(...sizes),
    buttons: buttons.length,
    anyOverflow: buttons.some((b) => b.getBoundingClientRect().right > doc.clientWidth + 1),
    pageOverflows: doc.scrollWidth > doc.clientWidth + 1,
  };
});
check("9b 手机端大字版：最小字号 ≥ 18px，按钮只有 3 个（字小/字大/退出）且不溢出", Boolean(mobileElder) && mobileElder.minFont >= 18 && mobileElder.buttons === 3 && !mobileElder.anyOverflow && !mobileElder.pageOverflows, mobileElder);
await mp.screenshot({ path: path.join(EVIDENCE, "family-real-mobile-elder.png"), fullPage: false });
await mobile.close();
await context.close();
await browser.close();

/* ── 7. 总账 ── */
const final = await counters();
const resolveAmap = final.amap - afterVerify.amap;
check("10 核验之后的全部操作 0 新增高德调用", resolveAmap === 0, { afterVerify: afterVerify.amap, final: final.amap });
check("11 全程 0 次百炼调用（讲解、读一句话都没有发起）", (final.understand ?? 0) === (before.understand ?? 0) && blockedPosts.every((p) => !/understand|agent/.test(p)), { understand: [before.understand, final.understand], blockedPosts });
check("12 全程 0 弹窗，服务进程没有重启", dialogs.length === 0 && final.pid === before.pid, { dialogs, pid: [before.pid, final.pid] });

const failed = results.filter((r) => !r.pass);
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: true,
  budget: { amap: "约 28（上限 40）", flyai: FLYAI_BUDGET, bailian: 0 },
  actual: { amap: final.amap - before.amap, amapPlace: final.amapPlace - before.amapPlace, amapWalking: final.amapWalking - before.amapWalking, flyai: (final.flyai ?? 0) - (before.flyai ?? 0), bailianUnderstand: (final.understand ?? 0) - (before.understand ?? 0) },
  verifySpent,
  resolveCalls: resolveLog.length,
  resolveAmapAfterVerify: resolveAmap,
  realItinerary: {
    categories: report.categories,
    stops: rawItinerary.stops.map((s) => ({ name: s.name, flyaiId: s.flyaiId })),
    totalWalkMinutes: rawItinerary.totalWalkMinutes,
    totalWalkMeters: rawItinerary.totalWalkMeters,
    legs: rawItinerary.legs.map((leg) => ({ from: leg.fromName, to: leg.toName, meters: leg.distanceMeters, minutes: leg.durationMinutes, polylinePoints: leg.polyline?.length ?? 0 })),
  },
  autoResolve: auto ? { request: auto.request, ok: auto.body?.ok, walk: auto.body?.itinerary?.totalWalkMinutes ?? null, stops: auto.body?.itinerary?.stops?.map((s) => s.name) ?? null } : null,
  steps: stepRecords,
  toilets: report.toilets ? { found: report.toilets.found, nearest: report.toilets.nearest?.length ?? 0 } : null,
  mobile: { adjust: mobileAdjust, elder: mobileElder },
  blockedPosts,
  dialogs,
  screenshots: ["family-real-route.png", "family-real-adjust.png", "family-real-elder.png", "family-real-mobile-adjust.png", "family-real-mobile-elder.png"],
  counters: { before, afterVerify, final },
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "family-real-accept.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过；实际花费：高德 ${summary.actual.amap}（核验 ${verifySpent}，之后 ${resolveAmap}），飞猪 ${summary.actual.flyai}，百炼 ${summary.actual.bailianUnderstand}`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
