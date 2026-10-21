/**
 * 阶段验收（真实高德地图 × 已核验行程）。
 * 在独立可见 Chromium 窗口里用真实鼠标事件跑完清单；只读 .env.local 做密钥包含检查，
 * 任何情况下都不打印密钥本身。
 *
 * 默认跑本地：`node evidence/phase6-accept.mjs`
 * 跑线上：    `BASE_URL=https://你的域名 node evidence/phase6-accept.mjs`（线上没有 .env.local，密钥检查自动跳过）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

/** 全局 npm 目录在不同系统上不一样，逐个候选找到能 require 到 playwright 的那个。 */
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

const envFile = path.join(ROOT, ".env.local");
const envPairs = fs.existsSync(envFile)
  ? fs
      .readFileSync(envFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => ({ name: line.slice(0, line.indexOf("=")).trim(), value: line.slice(line.indexOf("=") + 1).trim() }))
      .filter((pair) => pair.value.length > 8)
  : [];

const results = [];
const apiCalls = [];
let ok = true;

function check(name, pass, detail) {
  results.push({ name, pass });
  if (!pass) ok = false;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
}

const MAP_PROBE = `(() => {
  const el = document.querySelector('.amap-container');
  const m = el && el.amap;
  if (!m) return { error: 'no map instance' };
  const markers = m.getAllOverlays('marker') || [];
  const lines = m.getAllOverlays('polyline') || [];
  const c = m.getCenter();
  return {
    center: [+c.getLng().toFixed(6), +c.getLat().toFixed(6)],
    zoom: +m.getZoom().toFixed(2),
    size: [el.clientWidth, el.clientHeight],
    containers: document.querySelectorAll('.amap-container').length,
    canvases: document.querySelectorAll('.amap-container canvas').length,
    markers: markers.map((k) => {
      const p = k.getPosition();
      return { label: (k.getContent() || '').match(/aria-label="([^"]*)"/)?.[1] || '', pos: [+p.getLng().toFixed(6), +p.getLat().toFixed(6)] };
    }),
    lines: lines.map((l) => { const o = l.getOptions(); return { points: l.getPath().length, color: o.strokeColor, style: o.strokeStyle }; }),
  };
})()`;

const browser = await chromium.launch({ headless: false, executablePath: EXEC });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on("request", (req) => {
  const url = req.url();
  if (url.startsWith(`${BASE}/api/`)) apiCalls.push(`${req.method()} ${url.slice(BASE.length).split("?")[0]}`);
});

// 高德 SDK 偶发在 60 秒内不出图（真实网络下的加载抖动），这种时候重跑一次加载，
// 而不是让整轮验收跟着崩掉。调用计数按「最终成功的那一次加载」统计。
async function loadVerifiedMap() {
  apiCalls.length = 0;
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.click("text=开始核验（真实调用高德）");
  await page.waitForSelector("text=在地图定位", { timeout: 180000 });
  await page.waitForSelector(".amap-container canvas", { timeout: 60000 });
  await page.waitForTimeout(2500);
}
try {
  await loadVerifiedMap();
} catch (caught) {
  console.log(`首轮真实底图未出图（${String(caught).slice(0, 70)}…），重新加载一次`);
  await loadVerifiedMap();
}
// canvas 存在不等于底图有内容：瓦片是异步流进来的，实测空白时容器截图 5.7 万字节、
// 画满内容后 21 万字节。所以按截图字节数轮询，等到真的有底图再截图、再判定。
async function basemapBytes() {
  return (await page.locator(".amap-container").screenshot()).length;
}
async function waitForBasemap(attempts = 12) {
  let bytes = await basemapBytes();
  for (let i = 0; i < attempts && bytes < 120_000; i++) {
    await page.waitForTimeout(2500);
    bytes = await basemapBytes();
  }
  return bytes;
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(600);
const basemap = await waitForBasemap();
await page.screenshot({ path: path.join(EVIDENCE, "phase6-06-desktop-verified.png") });
const s1 = await page.evaluate(MAP_PROBE);
check("桌面端双栏：真实底图已渲染（canvas>0，只有一个地图实例）", s1.canvases > 0 && s1.containers === 1, { canvases: s1.canvases, containers: s1.containers, size: s1.size, zoom: s1.zoom });
check("底图不是空白网格：容器截图字节数达到有内容的水位（实测空白 5.7 万 / 有内容 21 万）", basemap > 120_000, { bytes: basemap });
// 这一站有几处是飞猪当次真实候选决定的（重新发现一次可能给 3 站也可能给 4 站），
// 所以断言「地图标记 = 卡片数 + 起点」，不把某个特定站数写死。
// 卡片上的定位按钮在当前选中那一站会写成「地图已定位」，两种文案都要算进来。
const stopCards = await page.evaluate(() =>
  Array.from(document.querySelectorAll("button")).filter((b) =>
    ["在地图定位", "地图已定位"].includes(b.textContent.trim()),
  ).length,
);
check(
  `起点 + ${stopCards} 个已核实地点全部落到地图`,
  stopCards >= 2 &&
    s1.markers.length === stopCards + 1 &&
    s1.markers.filter((m) => /^\d+\s/.test(m.label)).length === stopCards &&
    s1.markers.filter((m) => m.label.startsWith("起")).length === 1,
  { stops: stopCards, markers: s1.markers.map((m) => m.label) },
);
check("步行折线沿真实道路（每段点数远大于 2，不是两点直线）", s1.lines.every((l) => l.points > 2), s1.lines.map((l) => l.points));
// 主界面只能有一条路线：阶段一演示行程的标题（「标准半日」）不许再出现在页面上，
// 但它必须还能在开发调试面板里展开看到——旧路线是留在调试记录里，不是被删掉。
const bodyText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
check("核验后主界面不再并排显示阶段一演示行程", !bodyText.includes("标准半日"), {
  演示行程仍在主界面: bodyText.includes("标准半日"),
});
const debugSummary = page.locator("details > summary", { hasText: "开发调试面板" });
await debugSummary.click();
await page.waitForTimeout(500);
const debugText = await page.evaluate(() => {
  const panel = Array.from(document.querySelectorAll("details")).find((node) =>
    node.querySelector("summary")?.textContent.includes("开发调试面板"),
  );
  return panel ? panel.innerText.replace(/\s+/g, " ") : "";
});
check("旧路线保留在调试记录里（展开可看阶段一演示行程）", debugText.includes("阶段一演示行程") && debugText.includes("标准半日"), {
  片段: debugText.slice(0, 120),
});
await debugSummary.click();
await page.waitForTimeout(400);
// 顶栏是主界面最显眼的口径来源：核验成功后不能再挂着「演示数据 · 非实时」，
// 剩余时间也不能再用演示行程的模拟值。
const headerText = (await page.locator("header").first().innerText()).replace(/\s+/g, " ");
check(
  "顶栏跟着当前生效路线走（核验后改为真实核验口径）",
  headerText.includes("真实核验数据") &&
    headerText.includes("当前生效路线") &&
    headerText.includes("预算余") &&
    !headerText.includes("演示数据 · 非实时"),
  { header: headerText.slice(0, 200) },
);

// 卡片 → 地图：最后一张卡片的「在地图定位」应把地图中心移到那一站的实测坐标
const callsBeforeSelect = apiCalls.length;
const locate = page.locator('button:text-is("在地图定位")');
// 卡片上的地名是按钮所在行的第一个子节点，按名字去找对应标记，不按数量猜顺序
const targetName = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent.trim() === "在地图定位");
  const last = btns[btns.length - 1];
  return last && last.parentElement ? last.parentElement.firstElementChild.textContent.trim() : null;
});
const expected = s1.markers.find((m) => m.label.includes(String(targetName)));
await locate.last().click();
await page.waitForTimeout(1600);
const s2 = await page.evaluate(MAP_PROBE);
const offset = Math.round(Math.hypot(s2.center[0] - expected.pos[0], s2.center[1] - expected.pos[1]) * 111_000);
check(`卡片点选 → 地图定位到「${targetName}」`, offset < 80, { offsetMeters: offset, center: s2.center, marker: expected.pos });

// 缩放与平移：真实双击、工具栏 + 按钮、真实拖拽
const box = await page.locator(".amap-container").boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
// 双击要落在「就是底图」的地方：左上角那块图例是盖在地图上的 HTML 面板，
// 站点标记也随时会出现在任意位置，所以逐个候选点试，直到缩放真的发生。
const ZOOM_SPOTS = [
  [box.width - 140, box.height - 140],
  [box.width - 140, 130],
  [130, box.height - 140],
  [box.width / 2, 130],
];
let zoomBefore = null;
let zoomAfter = null;
for (const [dx, dy] of ZOOM_SPOTS) {
  zoomBefore = (await page.evaluate(MAP_PROBE)).zoom;
  await page.mouse.dblclick(box.x + dx, box.y + dy);
  await page.waitForTimeout(900);
  zoomAfter = (await page.evaluate(MAP_PROBE)).zoom;
  if (zoomAfter > zoomBefore) break;
}
check("双击放大生效", zoomAfter > zoomBefore, { from: zoomBefore, to: zoomAfter });
await page.locator(".amap-ctrl-zoomout").click();
await page.waitForTimeout(900);
const s4 = await page.evaluate(MAP_PROBE);
check("工具栏缩小按钮生效", s4.zoom < zoomAfter, { from: zoomAfter, to: s4.zoom });
// 滚轮：高德按累计量决定是否缩放，单次大 delta 会被忽略，所以要连续小步滚（实测 4×-120 才动）
await page.mouse.move(box.x + 120, box.y + box.height - 120);
for (let tick = 0; tick < 4; tick++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(320);
}
await page.waitForTimeout(700);
const s4b = await page.evaluate(MAP_PROBE);
check("滚轮连续缩放生效", s4b.zoom > s4.zoom, { from: s4.zoom, to: s4b.zoom });
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2 + 90, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(1000);
const s5 = await page.evaluate(MAP_PROBE);
const moved = Math.round(Math.hypot(s5.center[0] - s4b.center[0], s5.center[1] - s4b.center[1]) * 111_000);
check("按住拖动平移生效", moved > 150, { movedMeters: moved });
await page.screenshot({ path: path.join(EVIDENCE, "phase6-07-map-pan-zoom.png") });

// 标记 → 卡片：只点当前视口里真的看得见的标记，点完之后核对右侧芯片是否变成选中
async function firstVisibleMarker(candidates) {
  for (const m of candidates) {
    const b = await page.locator(`[aria-label="${m.label}"]`).boundingBox();
    if (b && b.x > box.x && b.x + b.width < box.x + box.width && b.y > box.y && b.y + b.height < box.y + box.height) {
      return { label: m.label, b };
    }
  }
  return null;
}
const numberedAtS5 = s5.markers.filter((x) => /^\d+\s/.test(x.label));
let picked =
  (await firstVisibleMarker(numberedAtS5.filter((x) => !x.label.includes(String(targetName))))) ??
  (await firstVisibleMarker(numberedAtS5));
// 大距离平移会把站点全甩出视口，这不能当成联动坏了：用卡片把地图移回某一站，再按新视口选点
if (!picked && numberedAtS5.length > 0) {
  console.log("拖动后视口里没有地点标记，先用卡片「在地图定位」把地图移回路线再选点");
  await locate.first().click();
  await page.waitForTimeout(1800);
  picked = await firstVisibleMarker((await page.evaluate(MAP_PROBE)).markers.filter((x) => /^\d+\s/.test(x.label)));
}
if (!picked) throw new Error("地图上找不到任何可见的地点标记，无法验收标记→卡片联动");
await page.mouse.click(picked.b.x + picked.b.width / 2, picked.b.y + 11);
await page.waitForTimeout(1200);
const stopName = picked.label.replace(/^\d+\s/, "");
const pressedChips = await page.locator(`button[aria-pressed="true"]:has-text("${stopName}")`).count();
check(`点击地图标记「${picked.label}」→ 右侧同步选中`, pressedChips >= 1, { stopName, pressedChips });
const idleCalls = apiCalls
  .slice(callsBeforeSelect)
  .filter((c) => c.includes("/api/agent") || c.includes("/api/verify") || c.includes("/api/route-geometry") || c.includes("/api/discover"));
check("缩放/平移/选点全程没有触发百炼或高德调用", idleCalls.length === 0, idleCalls);

// 我到了：真实百炼回合 + 地图状态同步
// 先选中第 1 站再到达：这样「少走一点」删的是后续站点，不会和已到达前缀冲突
await page.locator("button[aria-pressed]", { hasText: /^1\.\s/ }).first().click();
await page.waitForTimeout(1200);
// 百炼回合出现过一次「fetch failed」（服务端如实报错、不回落 Mock），重试一次确认是抖动而不是逻辑坏了
const arrived = async () => (await page.locator("text=已到达（手动模拟）").count()) >= 1;
for (let attempt = 1; attempt <= 2; attempt++) {
  await page.click('button:text-is("我到了")');
  await page.waitForFunction(
    () => document.body.innerText.includes("针对「") || document.body.innerText.includes("失败"),
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(1500);
  if (await arrived()) break;
  console.log(`第 ${attempt} 次「我到了」的百炼回合没有成功${attempt < 2 ? "，重试一次" : "，记为失败项"}`);
}
const s6 = await page.evaluate(MAP_PROBE);
const walked = s6.lines.filter((l) => l.style === "solid" && l.color === "#0d9488");
check("「我到了」后卡片显示已到达（手动模拟）", (await page.locator("text=已到达（手动模拟）").count()) >= 1);
check("走过的路段在地图上改为实线青色", walked.length >= 1, s6.lines.map((l) => `${l.color}/${l.style}`));
await page.screenshot({ path: path.join(EVIDENCE, "phase6-08-arrived-map-state.png") });

// 少走一点：等按钮从「调整校验中…」恢复，再核对地图站点集合
const adjustStart = apiCalls.length;
const before = { markers: s6.markers.length, names: s6.markers.map((m) => m.label) };
await page.click('button:text-is("少走一点")');
await page.waitForFunction(
  () => !Array.from(document.querySelectorAll("button")).some((b) => b.textContent.trim() === "调整校验中…"),
  null,
  { timeout: 150000 },
);
await page.waitForTimeout(2200);
const s7 = await page.evaluate(MAP_PROBE);
const adjustSection = await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.trim() === "少走一点");
  const sec = b ? b.closest("section") : null;
  return sec ? sec.innerText.replace(/\s+/g, " ").slice(0, 1400) : "missing";
});
const adjustIdx = adjustSection.indexOf("「少走一点」动态调整");
const adjustPart = adjustSection.slice(adjustIdx < 0 ? 0 : adjustIdx, adjustIdx < 0 ? 600 : adjustIdx + 600);
const dropped = before.names.filter((n) => !s7.markers.some((m) => m.label === n));
check("「少走一点」后地图同步为调整后的行程（旧站点标记被清除）", s7.markers.length < before.markers && dropped.length > 0, {
  before: before.markers,
  after: s7.markers.length,
  dropped,
  面板: adjustPart.slice(0, 260),
});
const domMarkers = await page.locator(".amap-container [aria-label]").count();
check("标记 DOM 数量与覆盖物数量一致（没有重复初始化或残留叠加）", domMarkers === s7.markers.length, { domMarkers, overlays: s7.markers.length });
const amapCalls = apiCalls.slice(adjustStart);
const reverifyNote = await page.locator("text=本次校验新发起高德步行实测").count();
check("调整结果带服务端高德复验凭证才上图", reverifyNote >= 1, { reverifyNote, amapCalls });
console.log("调整面板摘要:", adjustPart);
await page.screenshot({ path: path.join(EVIDENCE, "phase6-09-adjusted-route.png") });

// 手机端：地图标签在前，先截图再切走切回，避免截图停在文案页
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(800);
const s8 = await page.evaluate(MAP_PROBE);
check("手机端地图层级正常（12–18）", s8.zoom > 12 && s8.zoom < 18, { zoom: s8.zoom, size: s8.size, markers: s8.markers.length });
// 前面的点击会把页面滚到底，截图前回到顶部，否则截到的是文案而不是地图
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(500);
const mapBox = await page.locator(".amap-container").boundingBox();
check(
  "手机端地图容器就在首屏里（不需要滚动才能看到底图）",
  !!mapBox && mapBox.y >= -5 && mapBox.y + mapBox.height <= 844 && mapBox.width > 300,
  mapBox && { x: Math.round(mapBox.x), y: Math.round(mapBox.y), width: Math.round(mapBox.width), height: Math.round(mapBox.height) },
);
await page.screenshot({ path: path.join(EVIDENCE, "phase6-10-mobile-map.png") });
await page.click('button:text-is("行程与探索")');
await page.waitForTimeout(600);
await page.click('button:text-is("地图")');
await page.waitForTimeout(2500);
const s8b = await page.evaluate(MAP_PROBE);
check(
  "手机端切到文案再切回地图后仍按真实尺寸出图",
  s8b.canvases > 0 && s8b.containers === 1 && s8b.size[0] > 300 && s8b.size[1] > 200,
  { canvases: s8b.canvases, containers: s8b.containers, size: s8b.size, zoom: s8b.zoom },
);
await page.screenshot({ path: path.join(EVIDENCE, "phase6-15-mobile-map-back.png") });

// 密钥暴露检查：安全密钥、Web 服务 Key、飞猪 Key、百炼 Key 都不许出现在浏览器里。
// 高德 JS API Key 本来就是「Web 端」类型、必须交给浏览器加载 SDK，只允许出现在高德自己的 script 地址里。
if (envPairs.length === 0) {
  console.log(
    "跳过密钥暴露检查：本地没有 .env.local，没有明文可比对（线上跑时凭据在平台环境变量里）。",
  );
} else {
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  const present = envPairs.filter((pair) => html.includes(pair.value)).map((pair) => pair.name);
  const forbidden = ["AMAP_JS_SECURITY_CODE", "AMAP_WEB_KEY", "FLYAI_API_KEY", "DASHSCOPE_API_KEY", "BAILIAN_WORKSPACE_ID", "BAILIAN_AGENT_ID", "BAILIAN_ENV_ID"];
  check("浏览器 DOM 里没有安全密钥 / Web 服务 Key / 飞猪 Key / 百炼 Key", !present.some((name) => forbidden.includes(name)), { presentInDom: present });
  const jsKey = envPairs.find((pair) => pair.name === "AMAP_JS_KEY")?.value ?? "";
  const where = await page.evaluate((key) => {
    const scripts = Array.from(document.querySelectorAll("script")).filter((s) => (s.getAttribute("src") || "").includes(key));
    const hosts = scripts.map((s) => new URL(s.getAttribute("src")).host);
    let textNodes = 0;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent.includes(key)) textNodes++;
    return { scriptCount: scripts.length, hosts, textNodes };
  }, jsKey);
  check("JS API Key 只出现在高德 SDK 的 script 地址里，没有落进页面文本", where.scriptCount >= 1 && where.hosts.every((h) => h.includes("amap.com")) && where.textNodes === 0, where);
}

console.log("\n本站 API 调用（本次验收全程）:");
console.log(apiCalls.join("\n"));
console.log("\n=== 汇总 ===");
console.log(JSON.stringify({ ok, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).map((r) => r.name) }, null, 0));
await browser.close();
process.exit(ok ? 0 : 1);
