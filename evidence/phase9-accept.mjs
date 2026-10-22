/**
 * 第九阶段验收：双人协商界面（两个真实浏览器上下文 = 两台设备，真实可见视口，全程点击）。
 *
 * 走的是任务书那条场景：A 先跑出一条真实路线 → B 拿同伴链接说「我不想走超过这么多」→
 * 界面给出有符号差异并挂起旧确认 → B 先确认不生效 → A 也确认同一版 → 门禁放行，
 * 地图与行程面板切到双方确认的那一版，单人「少走一点」不再能替换它 → A 撤销，B 立刻只剩一句说明。
 *
 * 成本控制：脚本在开跑前自己发一次核验（冷跑 36 次高德：place 11 + walking 25），
 * 之后浏览器点的「生成我的路线」必须命中 30 分钟流水线缓存，所以整轮界面流程新增调用为 0，
 * 判定看服务端小时计数（见 0、1b、8）。B 的条件只在已实测段内重解；
 * 「必须去」那种需要补测的动作这里不做，因此一次补测也不会发生。
 *
 * 本地：`node evidence/phase9-accept.mjs`
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
].filter(Boolean);

function loadPlaywright() {
  for (const candidate of CLI_CANDIDATES) {
    try {
      return createRequire(candidate)("playwright");
    } catch {
      /* 换下一个候选路径 */
    }
  }
  return createRequire(import.meta.url)("playwright");
}

const { chromium } = loadPlaywright();
const BROWSER_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROME,
  path.join(os.homedir(), "AppData", "Local", "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe"),
].filter(Boolean);
const EXEC = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));

const results = [];
let ok = true;
function check(name, pass, detail) {
  results.push({ name, pass });
  if (!pass) ok = false;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
}

const shots = [];
async function shot(context, name) {
  const page = (await context.pages())[0];
  if (!page) return;
  const file = path.join(EVIDENCE, `phase9-${name}.png`);
  await page.screenshot({ path: file });
  shots.push(path.relative(ROOT, file).replace(/\\/g, "/"));
}

async function restCounters() {
  const status = await (await fetch(`${BASE}/api/verify`)).json();
  return { place: status.placeHourlyUsed, walking: status.walkingHourlyUsed, entries: status.cacheEntries, pid: status.pid };
}

/**
 * 预热必须用界面上真实的默认勾选（DEFAULT_DISCOVER_CATEGORIES = 单类别「自然风光」），
 * 否则「生成我的路线」点出来的是另一条流水线，缓存不命中，就会白付一次冷跑。
 * 冷跑只在这里发生一次；之后浏览器点击判定的是「命中缓存 = 0 次新增」。
 */
const UI_DEFAULT_CATEGORIES = ["自然风光"];
async function warm() {
  const response = await fetch(`${BASE}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cityName: "杭州", categories: UI_DEFAULT_CATEGORIES }),
  });
  const body = await response.json();
  return { status: response.status, ok: Boolean(body.report?.ok), facts: body.report?.facts?.factsId ?? null };
}

const NEG = 'section:has(h2:has-text("双人协商"))';
const CTA = 'button:has-text("生成我的路线")';

/** 面板里那条「总步行 N 米」就是界面上的步行口径，测试以它为数据源，不写死任何数字。 */
async function panelMeters(page) {
  const text = await page.locator(`${NEG} p`).filter({ hasText: "总步行" }).first().innerText();
  return Number((text.match(/总步行\s*(\d+)\s*米/) ?? [])[1] ?? -1);
}
async function gateText(page) {
  const text = await page.locator(`${NEG} div`).filter({ hasText: /正式执行|还不能正式执行/ }).first().innerText();
  return text.replace(/\s+/g, " ");
}
async function statusLine(page) {
  const text = await (await page.locator("p", { hasText: "已确认到达" }).first().innerText()).replace(/\s+/g, " ");
  return { line: text, stops: Number((text.match(/全程 (\d+) 站/) ?? [])[1] ?? -1) };
}
/** 全览是一段动画，中途读数会看到半个视野：连续两次读数的屏幕坐标基本不变才算落定。 */
async function markersSettled(page, timeoutMs = 8000) {
  const probe = () =>
    page.evaluate(() => {
      const el = document.querySelector(".amap-container");
      const m = el?.amap;
      if (!m) return null;
      return (m.getAllOverlays("marker") || []).map((k) => {
        const px = m.lngLatToContainer(k.getPosition());
        const label = (k.getContent() || "").match(/aria-label="([^"]*)"/)?.[1] || "";
        return { label, x: Math.round(px.x), y: Math.round(px.y) };
      });
    });
  const deadline = Date.now() + timeoutMs;
  let current = await probe();
  for (;;) {
    await page.waitForTimeout(400);
    const next = await probe();
    const still =
      Boolean(next) &&
      next.length === (current?.length ?? -1) &&
      next.every((k, i) => Math.abs(k.x - current[i].x) < 2 && Math.abs(k.y - current[i].y) < 2);
    current = next;
    if (still || Date.now() > deadline) {
      const box = await page.locator(".amap-container").boundingBox();
      return {
        markers: current ?? [],
        size: box ? [Math.round(box.width), Math.round(box.height)] : null,
        outside: (current ?? []).filter((k) => k.x < 0 || k.y < 0 || (box && (k.x > box.width || k.y > box.height))),
        settled: still,
      };
    }
  }
}

const browser = await chromium.launch({ headless: false, executablePath: EXEC });
const warmResult = await warm();
const baseline = await restCounters();
console.log(`预热：${JSON.stringify(warmResult)} 计数：${JSON.stringify(baseline)}`);
check("0 预热拿到真实事实层，冷跑成本已在承诺预算内", warmResult.ok && warmResult.facts !== null && baseline.place <= 11 && baseline.walking <= 25, {
  warmResult,
  baseline,
});

/* ── 1. A 这台设备：主界面 → 生成路线 → 发起协商 ─────────────────── */
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pageA = await ctxA.newPage();
const pageErrors = [];
pageA.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));

await pageA.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await pageA.waitForSelector(NEG, { timeout: 30000 });
const createBtn = pageA.locator(`${NEG} button:has-text("发起双人协商")`).first();
check(
  "1 还没有事实层时协商按钮是禁用的，并说清先做什么",
  (await createBtn.isDisabled()) && (await createBtn.innerText()).includes("先点「生成我的路线」"),
  { 按钮文案: await createBtn.innerText() },
);

await pageA.click(CTA);
await pageA.waitForFunction(() => document.body.innerText.includes("已确认到达"), null, { timeout: 240000 });
const afterVerify = await restCounters();
check(
  "1b 界面点出来的核验命中流水线缓存，新增高德调用为 0",
  afterVerify.place === baseline.place && afterVerify.walking === baseline.walking,
  { baseline, afterVerify },
);
check("2 有了真实事实层，协商按钮才可用", !(await createBtn.isDisabled()), { 按钮文案: await createBtn.innerText() });
await shot(ctxA, "01-before-create");

await createBtn.click();
await pageA.waitForSelector(`${NEG} h2:has-text("你是 A")`, { timeout: 30000 });
const linkInputs = pageA.locator(`${NEG} input[readonly]`);
const linkA = await linkInputs.nth(0).inputValue();
const linkB = await linkInputs.nth(1).inputValue();
const planId = new URL(linkA).pathname.split("/").pop();
const tokenA = decodeURIComponent(new URL(linkA).hash.match(/t=([^&]+)/)[1]);
const tokenB = decodeURIComponent(new URL(linkB).hash.match(/t=([^&]+)/)[1]);
check("2b 两条链接都指向浏览器实际访问的主机（不是 0.0.0.0）", new URL(linkA).host === new URL(BASE).host && new URL(linkB).host === new URL(BASE).host, {
  host: new URL(linkA).host,
});
check("2c 凭据只在 fragment 里，两个角色各一个", linkA.includes("#r=A&t=") && linkB.includes("#r=B&t=") && tokenA !== tokenB && tokenA.length >= 20);
const gateA0 = await gateText(pageA);
check("2d 一开始就写「还不能正式执行」", gateA0.includes("还不能正式执行"), { gateA0 });
const poolSelects = await pageA.locator(`${NEG} li select`).count();
check("2e 可点选的是已核验候选全集，不止入选的那几站", poolSelects > 6, { 可点选站点数: poolSelects });
const metersV1 = await panelMeters(pageA);
const statusV1 = await statusLine(pageA);
check("2f 第一版就是单人核验出来的那条真实路线", metersV1 > 0 && statusV1.stops > 0, { metersV1, 状态行: statusV1.line });
await shot(ctxA, "02-A-created");

/* ── 2. B 那台设备：只凭链接进来 ─────────────────────────────────── */
const ctxB = await browser.newContext({ viewport: { width: 420, height: 900 } });
const pageB = await ctxB.newPage();
pageB.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));
await pageB.goto(linkB, { waitUntil: "domcontentloaded" });
await pageB.waitForSelector(`${NEG} h2:has-text("你是 B")`, { timeout: 30000 });
check("3 B 用角色链接进来后确认自己是 B", (await pageB.locator(`${NEG} h2`).first().innerText()).includes("你是 B"));
check("3b 首帧读完就把凭据从地址栏清掉", !pageB.url().includes("#"), { url: pageB.url() });
const bPanel = await pageB.locator(NEG).innerText();
const bStorage = await pageB.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }));
check("3c B 的界面与本地存储里都没有 A 的凭据", !bPanel.includes(tokenA) && !bStorage.includes(tokenA));
const anonStatus = await pageB.evaluate(async ([base, id]) => (await fetch(`${base}/api/plan/${id}`)).status, [BASE, planId]);
const wrongStatus = await pageB.evaluate(
  async ([base, id]) => (await fetch(`${base}/api/plan/${id}`, { headers: { "x-plan-role-token": "0".repeat(32) } })).status,
  [BASE, planId],
);
check("3d 无凭据与错凭据都是同一个 401（不给枚举机会）", anonStatus === 401 && wrongStatus === 401, { anonStatus, wrongStatus });
await shot(ctxB, "03-B-landing");

/* ── 3. B 说「我不想走这么多」：上限由界面上的真实数字推出来 ─────── */
const cap = Math.max(200, metersV1 - 2500);
await pageB.fill(`${NEG} input[inputmode="numeric"]`, String(cap));
await pageB.click(`${NEG} button:has-text("提交我的条件")`);
await pageB.waitForFunction(() => document.body.innerText.includes("v1 → v2"), null, { timeout: 90000 }).catch(() => {
  /* 没有新版本时把当前面板原文留在下面的判定里，方便定位是真冲突还是没实测 */
});
const diffLine = await pageB
  .locator(`${NEG} li`)
  .filter({ hasText: "v1 → v2" })
  .first()
  .innerText()
  .catch(() => "");
check("4 B 提了更低的上限后出现 v1 → v2 的差异说明", diffLine.includes("总步行"), { diffLine, cap });
check("4b 差异带负号：新方案确实比旧方案少走", diffLine.includes("少走") && /[−-]/.test(diffLine), { diffLine });
const metersV2 = await panelMeters(pageB);
check("4c v2 的实测总步行满足 B 刚提的上限", metersV2 > 0 && metersV2 <= cap, { metersV2, cap });
const gateB = await gateText(pageB);
check("4d 单方改完条件仍不能执行，旧确认已挂起", gateB.includes("还不能正式执行"), { gateB });
await shot(ctxB, "04-B-diff");

/* ── 4. 只有 B 确认：必须不生效 ──────────────────────────────────── */
await pageB.click(`${NEG} button:text-is("确认 v2")`);
await pageB.waitForFunction(() => document.body.innerText.includes("你已确认 v2"), null, { timeout: 30000 });
const gateB2 = await gateText(pageB);
check("5 B 单方确认之后仍然不能执行", gateB2.includes("还不能正式执行"), { gateB2 });

/* ── 5. A 刷新看到同一版，再确认：门禁放行，地图切换 ─────────────── */
await pageA.reload({ waitUntil: "domcontentloaded" });
await pageA.waitForSelector(`${NEG} h2:has-text("你是 A")`, { timeout: 30000 });
const metersA2 = await panelMeters(pageA);
check("6 A 刷新后看到的也是 v2，数字与 B 那边一致", metersA2 === metersV2, { metersA2, metersV2 });
await pageA.click(`${NEG} button:text-is("确认 v2")`);
await pageA.waitForFunction(() => document.body.innerText.includes("正式执行：v2 已由双方确认"), null, { timeout: 30000 });
const gateA = await gateText(pageA);
check("7 双方确认同一版本后门禁才放行", gateA.includes("正式执行：v2"), { gateA });

const official = await pageA.evaluate(
  async ([base, id, tok]) => {
    const j = await (await fetch(`${base}/api/plan/${id}`, { headers: { "x-plan-role-token": tok } })).json();
    return { stops: (j.official?.itinerary?.stops ?? []).map((s) => s.name), meters: j.official?.itinerary?.totalWalkMeters ?? -1 };
  },
  [BASE, planId, tokenA],
);
const statusA = await statusLine(pageA);
const bodyA = await pageA.locator("body").innerText();
check("7b 主流程状态行切到了正式版本的站数", statusA.stops === official.stops.length, { 状态行: statusA.line, 正式版本站点数: official.stops.length });
// 先等全览动画落定再读标记：切换路线的一瞬间覆盖物会被重建，中途读数会拿到空列表
const fit = await markersSettled(pageA);
const markers = (fit.markers ?? []).map((k) => k.label);
// 地图标记的 aria-label 形如「1 平湖秋月」，带序号前缀，所以按包含关系判定，不做全等
check("7c 地图上的站点就是双方确认的那一版", official.stops.every((n) => markers.some((label) => label.includes(n))), {
  地图标记: markers,
  正式站点: official.stops,
});
check("7d 行程面板逐站列出的也是这一版", official.stops.every((n) => bodyA.includes(n)));
check("7d2 切换正式版本后地图重新全览，所有站点都在屏幕内", fit.settled && fit.outside.length === 0, {
  容器: fit.size,
  屏幕外: fit.outside,
  标记: fit.markers.map((k) => `${k.label}@${k.x},${k.y}`),
});
check(
  "7e 单人「少走一点」不再能替换双方确认的正式版本（双人那一侧的提案按钮仍在）",
  (await pageA.locator('button:text-is("少走一点")').count()) === 0 &&
    (await pageA.locator('button:has-text("双方确认版不可被单人替换")').count()) === 1 &&
    (await pageA.locator('button:has-text("只提提案，不改条件")').count()) === 1,
);
await shot(ctxA, "07-A-joint-executing");

/* ── 6. 全程没有额外花钱 ───────────────────────────────────────── */
const finalCounters = await restCounters();
check(
  "8 整条双人界面流程新增高德调用为 0",
  finalCounters.place === baseline.place && finalCounters.walking === baseline.walking,
  { baseline, finalCounters },
);
const budget = await pageA.evaluate(
  async ([base, id, tok]) => (await (await fetch(`${base}/api/plan/${id}`, { headers: { "x-plan-role-token": tok } })).json()).budget,
  [BASE, planId, tokenA],
);
check("8b 本方案的补测消耗也是 0", budget.spentThisPlan === 0 && budget.logicalRequests === 0, budget);
check("8c 两台设备上的页面都没有抛出未捕获错误", pageErrors.length === 0, { pageErrors });

/* ── 7. A 撤销：B 那边立刻只剩一句说明 ─────────────────────────── */
await pageA.click(`${NEG} button:has-text("撤销这两条链接")`);
await pageA.waitForFunction(() => document.body.innerText.includes("撤销"), null, { timeout: 30000 });
const gateAfterRevoke = await gateText(pageA);
check("9 A 撤销后自己这边的执行门禁也关上了", gateAfterRevoke.includes("还不能正式执行"), { gateAfterRevoke });
await pageA.click(`${NEG} button:has-text("退出这条协商")`);
await pageA.waitForFunction(() => document.body.innerText.includes("发起双人协商"), null, { timeout: 30000 });
await pageB.reload({ waitUntil: "domcontentloaded" });
// 410 是这一页重新打开后异步读回来的，等它落屏再判定，不把「还没读完」误判成「没说原因」
const seen = await pageB
  .waitForFunction(() => document.body.innerText.includes("撤销"), null, { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
const bText = await pageB.locator("body").innerText();
check("9b B 重新打开链接时只看到失效说明，并且说清了原因", seen && bText.includes("撤销"), {
  片段: bText.replace(/\s+/g, " ").slice(0, 200),
});
await shot(ctxB, "09-B-revoked");

await browser.close();
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} 通过`);
console.log(`高德小时计数：${JSON.stringify(baseline)} → ${JSON.stringify(finalCounters)}`);
console.log(`截图：${shots.join(" · ")}`);
process.exit(ok ? 0 : 1);
