/**
 * 第八阶段验收（现场演示稳定性）。
 * 只做用户点名的那三件事加两条一阶段的收尾：
 *   P0 高德 SDK 不能有阻塞式代理路径告警；浏览器只能看到官方一级路由 /_AMapService
 *   P0 刷新后行程、讲解、到达进度必须原样恢复，且恢复过程不产生任何真实调用
 *   P0 「生成我的路线」在手机首屏；出路线后「我到了／少走一点」一直可见
 *   P1 视口变化后所有站点重新回到屏幕内，并有「查看全程」
 *   P1 「少走一点」的三个收益数字与界面前后的行程数据自洽
 * 跑一次会真实消耗：一次核验（实测勾一个类别 36 次高德、两个类别 62 次）＋两个百炼回合。除此之外不重复触发。
 * 高德偶发单点失败会让整条核验中止（界面如实报错），此时脚本会再点一次，并把真实错误写进日志。
 *
 * 本地：`node evidence/phase8-accept.mjs`
 * 线上：`BASE_URL=https://你的域名 node evidence/phase8-accept.mjs`
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const CLI_CANDIDATES = [
  process.env.PLAYWRIGHT_CLI_PACKAGE,
  path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@playwright", "cli", "package.json"),
  path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@playwright", "cli", "package.json"),
  "/usr/local/lib/node_modules/@playwright/cli/package.json",
  "/usr/lib/node_modules/@playwright/cli/package.json",
].filter(Boolean);

function loadPlaywright() {
  for (const candidate of CLI_CANDIDATES) {
    try {
      return createRequire(candidate)("playwright");
    } catch {
      // 换下一个候选
    }
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

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const results = [];
let ok = true;
function check(name, pass, detail) {
  results.push({ name, pass });
  if (!pass) ok = false;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
}

const dialogs = [];
const browserCalls = { officialProxy: 0, handlerPath: 0, restApi: 0, sdkHost: 0, verify: 0, agent: 0, geometry: 0 };
/** 路径类判定看整轮累计（中途 resetCalls 会清零窗口计数），POST 计数才按窗口看。 */
const totals = { officialProxy: 0, handlerPath: 0, restApi: 0, sdkHost: 0, verify: 0, agent: 0 };
const shots = [];

/** 高德 SDK 在窄容器里算错层级是这次要防的坑，所以每次判定前先把容器尺寸打出来。 */
const MAP_PROBE = `(() => {
  const el = document.querySelector('.amap-container');
  const m = el && el.amap;
  if (!m) return { error: 'no map instance' };
  const size = [el.clientWidth, el.clientHeight];
  const project = (pos) => (m.lngLatToContainer ? m.lngLatToContainer(pos) : m.project(pos));
  const markers = (m.getAllOverlays('marker') || []).map((k) => {
    const pos = k.getPosition();
    const px = project(pos);
    const label = (k.getContent() || '').match(/aria-label="([^"]*)"/)?.[1] || '';
    return { label, x: Math.round(px.x), y: Math.round(px.y) };
  });
  return {
    size,
    zoom: typeof m.getZoom === 'function' ? +m.getZoom().toFixed(2) : null,
    canvases: document.querySelectorAll('.amap-container canvas').length,
    markers,
    outside: markers.filter((k) => k.x < 0 || k.y < 0 || k.x > size[0] || k.y > size[1]),
  };
})()`;

const browser = await chromium.launch({ headless: false, executablePath: EXEC });
const context = await browser.newContext({ viewport: { ...MOBILE } });
const page = await context.newPage();

/** 全览是一段高德动画，中途读数会看到半个视野。等它停下来再判定：连续两次读数的屏幕坐标基本不变就算落定。 */
async function mapSettled(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let current = await page.evaluate(MAP_PROBE);
  for (;;) {
    await page.waitForTimeout(400);
    const next = await page.evaluate(MAP_PROBE);
    const still =
      next.markers?.length === current.markers?.length &&
      (next.markers ?? []).every(
        (k, i) => Math.abs(k.x - current.markers[i].x) < 2 && Math.abs(k.y - current.markers[i].y) < 2,
      );
    current = next;
    if (still || Date.now() > deadline) return { ...current, settled: still };
  }
}

page.on("dialog", async (dialog) => {
  dialogs.push(`${dialog.type()}: ${(dialog.message() || "").slice(0, 160)}`);
  await dialog.dismiss();
});

page.on("request", (request) => {
  const url = request.url();
  const tally = (key) => {
    browserCalls[key] += 1;
    if (key in totals) totals[key] += 1;
  };
  if (url.includes("/_AMapService/")) tally("officialProxy");
  if (url.includes("/amap-proxy/")) tally("handlerPath");
  // restapi 是数据接口：浏览器直接打它就等于绕开服务端代理，必须为 0
  if (url.includes("restapi.amap.com")) tally("restApi");
  // webapi 是 SDK 自己的脚本与样式来源，本来就必须由高德域名提供
  if (url.includes("webapi.amap.com")) tally("sdkHost");
  if (!url.startsWith(BASE)) return;
  const route = url.slice(BASE.length).split("?")[0];
  if (request.method() === "POST" && route === "/api/verify") tally("verify");
  if (request.method() === "POST" && route === "/api/agent") tally("agent");
  if (route.startsWith("/api/route-geometry")) tally("geometry");
});

async function shot(name) {
  const file = path.join(EVIDENCE, `phase8-${name}.png`);
  await page.screenshot({ path: file });
  shots.push(path.relative(ROOT, file).replace(/\\/g, "/"));
}

async function restCounters() {
  const status = await (await fetch(`${BASE}/api/verify`)).json();
  return { place: status.placeHourlyUsed, walking: status.walkingHourlyUsed, entries: status.cacheEntries };
}

/** 再取一次同输入的报告要赶在流水线缓存（30 分钟）里 = 缓存命中，不产生新的高德调用。 */
async function postVerify(cityName, categories) {
  const response = await fetch(`${BASE}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cityName, categories }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`POST /api/verify ${response.status}：${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.report ?? body;
}

function resetCalls() {
  for (const key of Object.keys(browserCalls)) browserCalls[key] = 0;
}

/** 底部状态行是屏幕上站数与总时长的唯一口径，收益数字就照它对照。 */
async function statusLine() {
  const text = await page.locator("p", { hasText: "已确认到达" }).first().innerText();
  return text.replace(/\s+/g, " ");
}
const stopsOf = (line) => Number((line.match(/全程 (\d+) 站/) ?? [])[1] ?? -1);
const minutesOf = (line) => Number((line.match(/站 \/ (\d+) 分钟/) ?? [])[1] ?? -1);

/** 百炼面板按标题定位，避免和「当前地点」那块演示面板的同名元素混在一起。 */
const AGENT_SECTION = 'section:has(h2:text-is("在场探索 · 百炼托管智能体"))';
const badgeText = () => page.locator(`${AGENT_SECTION} span.shrink-0`).first().innerText();
const narrationBox = () => page.locator("div.border-brand-100").filter({ hasText: "百炼 · 千问" }).first();
const savingsBox = () => page.locator("div.border-brand-100").filter({ hasText: "总行程缩短" }).first();

const ctaSelector = "button:text-is(\"生成我的路线\")";

// ── 1. 手机端首屏就能点到「生成我的路线」 ──────────────────────────
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(ctaSelector, { timeout: 30000 });
const ctaBox = await page.locator(ctaSelector).boundingBox();
const firstScreenCta = ctaBox !== null && ctaBox.y + ctaBox.height <= MOBILE.height;
check("手机端「生成我的路线」在首屏内", firstScreenCta, { cta: ctaBox, viewport: MOBILE });

const cardButtons = await page.locator("button:has-text(\"加入路线\")").count();
check("发现卡片不再堆满主流程", cardButtons === 0, { 手工加站按钮数: cardButtons });
await shot("01-mobile-first-screen");

const ctaHint = (await page.locator("button:text-is(\"生成我的路线\") ~ p").first().innerText()).replace(/\s+/g, "");
const hintCats = (ctaHint.match(/按「([^」]+)」/) ?? [])[1] ?? "";
const checkedCats = hintCats.split("+").map((name) => name.trim()).filter(Boolean);
check(
  "主按钮说清候选池来自勾选的类别",
  ["自然风光", "文创街区", "城市观光"].some((name) => hintCats.includes(name)),
  { hintCats, ctaHint },
);

// ── 2. 一次真实核验（高德偶发的单点失败会让整条核验中止，界面如实报错，所以允许再点一次） ──
const beforeVerify = await restCounters();
resetCalls();
let verifyClicks = 0;
let verifyError = null;
for (let attempt = 1; attempt <= 2; attempt += 1) {
  verifyClicks += 1;
  await page.click(ctaSelector);
  try {
    // 手机端「行程与探索」那一栏在地图标签下是隐藏的，所以按屏底状态行的文字判定，不按面板内按钮的可见性
    await page.waitForFunction(() => document.body.innerText.includes("已确认到达"), null, { timeout: 240000 });
    break;
  } catch {
    verifyError = await page.evaluate(() => {
      const line = document.body.innerText.split("\n").find((l) => /失败|超限|错误|没有返回/.test(l));
      return line ? line.trim().slice(0, 200) : "界面上没有可读的错误行";
    });
    if (attempt === 2) throw new Error(`两次核验都没跑通，界面停在：${verifyError}`);
    console.log(`第 ${attempt} 次核验被服务端如实报错（${verifyError}），再点一次`);
  }
}
await page.waitForSelector(".amap-container canvas", { timeout: 90000 });
await page.waitForTimeout(3000);
const afterVerify = await restCounters();

check(
  "每一次点击只发一次核验请求",
  browserCalls.verify === verifyClicks,
  { verifyClicks, verifyError, browserCalls },
);
check(
  "浏览器只走官方一级路由 /_AMapService，内部 handler 路径与数据接口都不出现在浏览器里",
  totals.officialProxy > 0 && totals.handlerPath === 0 && totals.restApi === 0,
  { ...totals },
);
check(
  "高德 SDK 没有弹出阻塞提示",
  dialogs.length === 0 && !dialogs.some((d) => d.includes("_AMapService")),
  { dialogs },
);

// ── 2b. 勾选的类别真的决定候选池（取刚才那份缓存报告，不产生新调用） ──
const countersBeforeCacheRead = await restCounters();
const report = await postVerify("杭州", checkedCats);
const countersAfterCacheRead = await restCounters();
const categoryByStopId = new Map((report.matches ?? []).map((match) => [match.flyaiId, match.category]));
const stopCategories = (report.itinerary?.stops ?? []).map((stop) => categoryByStopId.get(stop.flyaiId) ?? null);
check(
  "核验走真实高德链路（报告自带调用与命中计数；0 新增＝命中 6 小时缓存，不是 Mock）",
  report.ok === true &&
    report.amap?.keyPresent === true &&
    report.amap.placeCalls + report.amap.walkingCalls + report.amap.cacheHits > 0 &&
    Boolean(report.itinerary?.stops.length),
  {
    本小时新增: {
      place: afterVerify.place - beforeVerify.place,
      walking: afterVerify.walking - beforeVerify.walking,
    },
    报告计数: report.amap && {
      place: report.amap.placeCalls,
      walking: report.amap.walkingCalls,
      cacheHits: report.amap.cacheHits,
      failed: report.amap.failedCalls,
    },
  },
);
check(
  "同输入重取报告命中流水线缓存（服务端计数一格没涨）",
  countersAfterCacheRead.place === countersBeforeCacheRead.place &&
    countersAfterCacheRead.walking === countersBeforeCacheRead.walking,
  { before: countersBeforeCacheRead, after: countersAfterCacheRead },
);
check("报告记录的类别＝界面勾选的类别", (report.categories ?? []).join("+") === checkedCats.join("+"), {
  报告: report.categories,
  勾选: checkedCats,
});
check(
  "每一站都在勾选类别的候选里（没有偷偷混入别的类别）",
  stopCategories.length > 0 && stopCategories.every((category) => checkedCats.includes(category)),
  { 每站类别: stopCategories, 飞猪候选: report.candidateCount, 调用凭证条数: (report.flyaiProofs ?? []).length },
);

const mobileBar = await page.locator("button:has-text(\"我到了\")").boundingBox();
check(
  "出路线后「我到了／少走一点」仍在手机首屏",
  mobileBar !== null && mobileBar.y >= 0 && mobileBar.y + mobileBar.height <= MOBILE.height,
  { arrived: mobileBar, viewport: MOBILE },
);
// 往下滚一段（手机上翻文案），按钮必须还钉在屏幕下沿
await page.evaluate(() => window.scrollBy(0, 600));
await page.waitForTimeout(600);
const scrolledBar = await page.locator("button:text-is(\"少走一点\")").boundingBox();
check(
  "滚动之后核心按钮依然钉在屏幕内（不用回到首屏去点）",
  scrolledBar !== null && scrolledBar.y >= 0 && scrolledBar.y + scrolledBar.height <= MOBILE.height,
  { scrolled: scrolledBar },
);
await page.evaluate(() => window.scrollTo(0, 0));
await shot("02-mobile-action-bar");

// ── 3. 刷新恢复：行程 → 讲解 → 到达进度 ───────────────────────────
// 面板在窄屏是藏在「行程与探索」标签里的，恢复类断言要看面板文本，所以先回桌面视口再刷新。
await page.setViewportSize({ ...DESKTOP });
await page.waitForTimeout(1500);
const stopsBefore = stopsOf(await statusLine());
const statusLineBefore = await statusLine();
const beforeReloadCounters = await restCounters();
resetCalls();

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("text=这一份是刷新前本标签页已经核验过的结果", { timeout: 30000 });
await page.waitForSelector(".amap-container canvas", { timeout: 90000 });
await page.waitForTimeout(2500);
const afterReloadCounters = await restCounters();
const lineAfterReload = await statusLine();
const stopsAfterReload = stopsOf(lineAfterReload);

check("刷新后没有重新发起核验（0 次 POST /api/verify）", browserCalls.verify === 0, { browserCalls });
check(
  "刷新后高德 REST 请求计数没有增长（真恢复，不是重跑）",
  afterReloadCounters.place === beforeReloadCounters.place && afterReloadCounters.walking === beforeReloadCounters.walking,
  { before: beforeReloadCounters, after: afterReloadCounters },
);
check(
  "刷新后站数与状态行原样恢复",
  stopsAfterReload === stopsBefore && stopsAfterReload > 0 && lineAfterReload === statusLineBefore,
  { stopsBefore, stopsAfterReload, statusLineBefore, lineAfterReload },
);
const restoredMap = await page.evaluate(MAP_PROBE);
check("刷新后仍是真实底图", !restoredMap.error && restoredMap.canvases > 0 && restoredMap.markers.length > 0, {
  canvases: restoredMap.canvases,
  markers: restoredMap.markers?.length,
});
await shot("03-restored-after-reload");

// ── 4. 「我到了」：一个真实百炼回合，再刷新看讲解是否回来 ──────────
resetCalls();
await page.click("button:has-text(\"我到了\")");
await page.waitForSelector("text=下一步 ·", { timeout: 240000 });
await page.waitForTimeout(1500);
const badgeLive = (await badgeText()).trim();
const narrationLive = (await narrationBox().innerText()).replace(/\s+/g, " ");
const statusLineArrived = await statusLine();
check("「我到了」买了一个真实回合", browserCalls.agent === 1, { browserCalls });
check("刚点出来的这一轮标为百炼真实返回", badgeLive.includes("百炼真实返回"), { badgeLive });
check("到达后被记进进度", /已确认到达 [1-9]/.test(statusLineArrived), { statusLineArrived });
await shot("04-narration-live");

resetCalls();
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("text=LIVE · 刷新前那一次", { timeout: 30000 });
await page.waitForTimeout(2000);
const badgeRestored = (await badgeText()).trim();
const narrationRestored = (await narrationBox().innerText()).replace(/\s+/g, " ");
const statusLineRestored = await statusLine();
check("刷新后讲解徽标说明这是上一轮的真实返回", badgeRestored.includes("刷新前那一次"), { badgeRestored });
check(
  "刷新后讲解原文与到达记录一起回来",
  narrationRestored === narrationLive && statusLineRestored === statusLineArrived,
  { statusLineRestored, 讲解字数: narrationRestored.length },
);
check("刷新恢复讲解没有再买回合（0 次 POST /api/agent）", browserCalls.agent === 0, { browserCalls });

// ── 5. 「少走一点」的收益数字与界面前后自洽 ────────────────────────
const totalBefore = minutesOf(statusLineRestored);
resetCalls();
await page.click("button:text-is(\"少走一点\")");
await page.waitForSelector("text=总行程缩短", { timeout: 300000 });
await page.waitForTimeout(1500);
const savingsText = (await savingsBox().innerText()).replace(/\s+/g, " ");
const statusLineAfter = await statusLine();
const totalAfter = minutesOf(statusLineAfter);
/** 界面按「N 小时 M 分」显示，这里换算回分钟再和前后行程对账。 */
const savedOf = (text) => {
  const m = text.match(/总行程缩短\s*(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分(?:钟)?)?/);
  if (!m || (m[1] === undefined && m[2] === undefined)) return -1;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
};
const claimedSaved = savedOf(savingsText);
check(
  "「总行程缩短」= 界面前后两份高德实测行程之差",
  totalBefore > 0 && totalAfter > 0 && claimedSaved === totalBefore - totalAfter,
  { totalBefore, totalAfter, claimedSaved, savingsText: savingsText.slice(0, 220) },
);
check(
  "收益三格都给出（少走 / 少步行 / 总行程缩短）",
  /少走 /.test(savingsText) && /少步行 /.test(savingsText),
  { savingsText: savingsText.slice(0, 120) },
);
await shot("05-savings-and-adjusted-route");

// ── 6. 视口切换后所有站点重新回到屏幕内 ──────────────────────────
// 用户实测的那条路径是「桌面选好站 → 切成手机宽度 → 只剩湖面」，所以先点最远的一站。
await page.locator(`${AGENT_SECTION} button[aria-pressed]`).last().click();
await page.waitForTimeout(1500);
await page.setViewportSize({ ...MOBILE });
await page.waitForTimeout(1800);
const mobileMarkers = await page.evaluate(MAP_PROBE);
check(
  "桌面切到 390×844 后所有站点重新回到底图内",
  !mobileMarkers.error && mobileMarkers.outside.length === 0 && mobileMarkers.markers.length > 0,
  { size: mobileMarkers.size, outside: mobileMarkers.outside, markers: mobileMarkers.markers },
);
await shot("06-mobile-fit");

const fitButton = page.locator("button:has-text(\"查看全程\")");
check("「查看全程」按钮存在", (await fitButton.count()) === 1);
// 放大到只剩局部（等价于用户自己滚轮放大），再用按钮拉回全览
const zoomedIn = await page.evaluate(() => {
  const el = document.querySelector(".amap-container");
  const m = el && el.amap;
  if (!m || typeof m.setZoomAndCenter !== "function") return { error: "没有可用的地图实例" };
  m.setZoomAndCenter(17, m.getAllOverlays("marker")[0].getPosition(), true);
  return { ok: true };
});
await page.waitForTimeout(1200);
const zoomed = await page.evaluate(MAP_PROBE);
check(
  "放大后确有站点移出屏幕（这就是「查看全程」要解决的场景）",
  !zoomedIn.error && zoomed.outside.length > 0,
  { zoom: zoomed.zoom, outside: zoomed.outside.map((k) => k.label) },
);
await fitButton.click();
const refit = await mapSettled();
check(
  "点「查看全程」后全览重新收进所有站点",
  refit.outside.length === 0 && refit.markers.length > 0,
  { zoom: refit.zoom, settled: refit.settled, size: refit.size, outside: refit.outside, markers: refit.markers.length },
);
await shot("07-fit-all-back");

// ── 7. 主界面的技术说明是否真的收进了折叠区 ───────────────────────
// 回到桌面视口：窄屏会把整栏文案藏起来，那时候「看不见」不代表「收进了折叠区」。
await page.setViewportSize({ ...DESKTOP });
await page.waitForTimeout(1500);
const hiddenProof = await page.evaluate(() => {
  const needles = ["search-poi", "坐标系", "GCJ-02", "v5/place", "阶段"];
  const visibleLeaks = [];
  for (const needle of needles) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.nodeValue || "";
      if (!text.includes(needle)) continue;
      const host = walker.currentNode.parentElement;
      if (!host) continue;
      const details = host.closest("details");
      const onScreen = host.offsetParent !== null && !(details && !details.open);
      if (onScreen) visibleLeaks.push({ needle, snippet: text.trim().slice(0, 60) });
    }
  }
  return {
    detailsCount: document.querySelectorAll("details").length,
    openDetails: [...document.querySelectorAll("details")].filter((d) => d.open).length,
    visibleLeaks,
  };
});
check("技术证明只在折叠区里", hiddenProof.visibleLeaks.length === 0 && hiddenProof.detailsCount >= 3, hiddenProof);

// ── 汇总 ────────────────────────────────────────────────────────
const finalCounters = await restCounters();
console.log("\n本轮真实用量（服务端计数）");
console.log(`  高德 Web 服务：place ${finalCounters.place}/40，walking ${finalCounters.walking}/80，缓存 ${finalCounters.entries} 条`);
console.log(`  本轮路线：类别 ${checkedCats.join("+")} · 飞猪候选 ${report.candidateCount} 条 · 成线 ${report.itinerary?.stops.length} 站 / ${report.itinerary?.totalMinutes} 分钟`);
console.log(`  浏览器发出的核验 POST：${totals.verify} 次 · 百炼回合 POST：${totals.agent} 次`);
console.log(`  官方代理路径 ${totals.officialProxy} 次 · 内部 handler 路径 ${totals.handlerPath} 次 · 浏览器直连数据接口 ${totals.restApi} 次 · SDK 脚本来源 ${totals.sdkHost} 次`);
console.log(`  弹窗：${dialogs.length} 次${dialogs.length ? ` → ${dialogs.join(" | ")}` : ""}`);
console.log(`  截图：${shots.join(" · ")}`);
const failed = results.filter((r) => !r.pass).map((r) => r.name);
console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length ? `；未通过：${failed.join("、")}` : ""}`);

await browser.close();
process.exit(ok ? 0 : 1);
