/**
 * 「爸妈全程一共能走多久」零付费 UI 验证（唯一一条条件，单位分钟）：
 * 生成前的提问与三态（没答 / 答了「不确定」/ 选了数字）、生成后按答案自动重解、
 * 「调整」页恢复已答的那一档、单段那一问不再露出、失败如实提示并给分钟建议、
 * 大字版按分钟判断、每站停留一档（D2）与账单、「少走一点」已删除（D1）、手机不溢出，以及界面密度（按钮数与字数）。
 *
 * 全程拦截 /api/verify 与 /api/resolve 并返回桩结果，其余付费端点一律拦截：本脚本只验证界面与接线，
 * 不代表真实路线或真实重解结果。服务端真实措辞与数字由 solo-resolve-unit.mjs 覆盖；
 * 真实数据验收见 family-real-accept.mjs（付费，需先报预算）。
 * 默认无头运行；要看着浏览器跑：HEADED=1 node evidence/preflight-ui.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { FIXTURE_REPORT, FIXTURE_SNAPSHOT } from "./preflight-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";

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

/** 每个场景各记各的请求，断言才不会被别的场景串味 */
function makeStubs() {
  return { resolveBodies: [], verifyCalls: 0, resolveMode: "ok", externalBlocked: [] };
}

function stubOk(body) {
  const minutes = body.maxWalkMinutes ?? null;
  const stay = body.stayMinutes ?? 30;
  const stops = FIXTURE_REPORT.itinerary.stops.map((stop) => ({ ...stop, stayMinutes: stay }));
  return {
    ok: true,
    cost: { newAmapCalls: 0 },
    execution: { allowed: true, reason: "桩：满足条件" },
    explanation: {
      totalWalkMeters: 1800,
      totalWalkMinutes: 30,
      limit: null,
      limitMinutes: minutes,
      withinLimit: true,
      withinMinutesLimit: minutes === null || 30 <= minutes,
      longestSegmentMeters: 900,
      segmentLimit: null,
      withinSegmentLimit: true,
      verdict: minutes === null
        ? "这条路线全天走 1800 米（你没有设走路上限），步行约 30 分钟。"
        : `这条路线全程步行约 30 分钟（1800 米），在您定的 ${minutes} 分钟以内。`,
      whyDropped: minutes === null
        ? []
        : [{ id: "x", name: "满陇桂雨", text: `保留「满陇桂雨」全程要步行约 45 分钟，超出你定的 ${minutes} 分钟，所以这次没排它。` }],
      keptBecauseMust: [],
      withoutLimit: { totalWalkMeters: 2600, totalWalkMinutes: 45, stopCount: 4 },
      stayMinutes: stay,
      stayNote: stay === 60 ? "每站停留 60 分钟时，半日 240 分钟里最多排 2 站；每站停 15 分钟可以排 3 站。" : null,
    },
    itinerary: {
      ...FIXTURE_REPORT.itinerary,
      stops,
      totalWalkMeters: 1800,
      totalWalkMinutes: 30,
      totalStayMinutes: stay * stops.length,
      bufferMinutes: 20,
      totalMinutes: 30 + stay * stops.length + 20,
    },
    note: "桩",
  };
}
function stubFail() {
  return {
    ok: false,
    code: "no-solution",
    reason: "桩：按当前条件最多只能排 1 个站，少于半日游最少需要的 2 站。放宽到 10 分钟可以排 2 站（全程步行约 10 分钟）。",
    suggestion: { maxWalkMinutes: 10, maxWalkMeters: 800, stopCount: 2, totalWalkMeters: 800, totalWalkMinutes: 10 },
    cost: { newAmapCalls: 0 },
  };
}

/** 给一个 context 装上拦截：verify / resolve 返回桩，其余付费端点与一切外网一律拦截 */
async function stubContext(context, stubs, { verifyAsFixture }) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "POST" && /\/api\/resolve/.test(url)) {
      const body = JSON.parse(req.postData() ?? "{}");
      stubs.resolveBodies.push(body);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(stubs.resolveMode === "ok" ? stubOk(body) : stubFail()),
      });
    }
    if (req.method() === "POST" && /\/api\/verify/.test(url) && verifyAsFixture) {
      stubs.verifyCalls += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ report: FIXTURE_REPORT, categories: ["自然风光"] }),
      });
    }
    if (req.method() === "POST" && /\/api\/(verify|discover|route-geometry|agent|plan)/.test(url)) return route.abort();
    try {
      const host = new URL(url).hostname;
      if (host === "localhost" || host === "127.0.0.1") return route.continue();
      stubs.externalBlocked.push(host);
    } catch { /* ignore */ }
    return route.abort();
  });
}

const OPTION_LABELS = ["30 分钟", "1 小时", "1.5 小时", "不确定"];
const classOf = async (page, label) =>
  (await page.getByRole("button", { name: new RegExp(`^${label}`) }).first().getAttribute("class")) ?? "";
// 按完整类名比对：没选中的按钮带 hover:border-brand-600/40，用 includes 会把悬停样式误判成选中
const isSelected = async (page, label) => (await classOf(page, label)).split(/\s+/).includes("border-brand-600");

const browser = await chromium.launch({
  headless: process.env.HEADED !== "1",
  executablePath: EXEC,
  args: ["--lang=zh-CN"],
});

/* ═════════ 场景 A：选 30 分钟 → 生成 → 自动按它重排 → 调整页 → 再改 → 失败 → 大字版 ═════════ */
const A = makeStubs();
const contextA = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
await stubContext(contextA, A, { verifyAsFixture: true });
const page = await contextA.newPage();
const dialogs = [];
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1500);

/* 1. 生成前就能看到这一问，且只有这一问 */
const firstText = await page.evaluate(() => document.body.innerText);
check("1 生成路线之前就能看到「爸妈全程一共能走多久」", firstText.includes("爸妈全程一共能走多久"));
check("1b 四个选项都在：30 分钟 / 1 小时 / 1.5 小时 / 不确定", OPTION_LABELS.every((label) => firstText.includes(label)), OPTION_LABELS.filter((l) => !firstText.includes(l)));
check("1c 说明先定就不用生成完再改", firstText.includes("生成时就直接按它排"));
check("1d 写明时间是按高德的步行速度估的", firstText.includes("按高德的步行速度估"));
check("1e 旧的米数档位与说法已经没有", !/走不远|约 2 公里|约 3\.5 公里|爸妈大概能走多远/.test(firstText));
check("1f 此时没有重解请求", A.resolveBodies.length === 0, { calls: A.resolveBodies.length });
const noneSelected = (await Promise.all(OPTION_LABELS.map((label) => isSelected(page, label)))).every((value) => !value);
check("1g 还没回答时任何选项都不高亮（不替用户预先答）", noneSelected);

/* 2. 选档：只记状态，不发请求；三态之间切换 */
await page.getByRole("button", { name: /^30 分钟/ }).click();
await page.waitForTimeout(400);
check("2 选 30 分钟后它高亮、其余不高亮", (await isSelected(page, "30 分钟")) && !(await isSelected(page, "1 小时")) && !(await isSelected(page, "不确定")));
await page.getByRole("button", { name: /^不确定/ }).click();
await page.waitForTimeout(400);
check("2b 改答「不确定」后它高亮、30 分钟不再高亮", (await isSelected(page, "不确定")) && !(await isSelected(page, "30 分钟")));
await page.getByRole("button", { name: /^30 分钟/ }).click();
await page.waitForTimeout(400);
check("2c 没有事实集时选档不发重解", A.resolveBodies.length === 0, { calls: A.resolveBodies.length });
await page.screenshot({ path: path.join(EVIDENCE, "preflight-desktop.png"), fullPage: false });

/* 3. 点「生成我的路线」：核验（桩）完成后，按已答的 30 分钟自动重解一次，请求体里只有分钟 */
await page.getByRole("button", { name: /生成我的路线/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("桩站点A（夹具）"), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
check("3 点生成后走了一次核验（桩）", A.verifyCalls === 1, { verifyCalls: A.verifyCalls });
check("3b 核验完成后自动按 30 分钟重解，恰好 1 次", A.resolveBodies.length === 1 && A.resolveBodies[0].maxWalkMinutes === 30, A.resolveBodies);
check("3c 请求体里没有米数口径，也没有单段上限", A.resolveBodies.every((b) => !("maxWalkMeters" in b) && !("maxSegmentMeters" in b)), A.resolveBodies);
const afterGenerate = await page.evaluate(() => document.body.innerText);
check("3d 生成后看到的是路线（含桩站点）", afterGenerate.includes("桩站点A（夹具）"));

/* 4. 「调整」页：只有一条条件，已答的那一档还在 */
await page.getByRole("tab", { name: "调整" }).click();
await page.waitForTimeout(800);
const panel = page.getByRole("region", { name: "爸妈能走多久" });
check("4 「调整」页有「爸妈全程一共能走多久」面板", await panel.isVisible().catch(() => false));
const adjustText = await panel.innerText().catch(() => "");
check("4b 面板里四个选项都在", OPTION_LABELS.every((label) => adjustText.includes(label)));
check("4c 生成前答的 30 分钟在这里仍是高亮（答案没丢）", await isSelected(page, "30 分钟"));
check("4d 「一口气最多走多远」不再露出", !adjustText.includes("一口气最多走多远") && !/一小段|只要能走就行/.test(adjustText), adjustText.match(/一口气[^\n]*/)?.[0] ?? null);
check("4e 面板写出当前这条要走多久", /当前全程步行约 30 分钟/.test(adjustText), adjustText.match(/当前[^\n]*/)?.[0] ?? null);
check("4f 打开「调整」页本身不发请求", A.resolveBodies.length === 1, { calls: A.resolveBodies.length });
await page.screenshot({ path: path.join(EVIDENCE, "preflight-adjust.png"), fullPage: false });

/* 5. 在调整页改选：每次点击恰好 1 次请求（不再重复发一遍），请求体只有分钟 */
await page.getByRole("button", { name: /^1 小时/ }).click();
await page.waitForTimeout(1800);
check("5 选 1 小时：恰好多 1 次重解，maxWalkMinutes=60", A.resolveBodies.length === 2 && A.resolveBodies[1].maxWalkMinutes === 60, A.resolveBodies.at(-1));
const afterHour = await page.evaluate(() => document.body.innerText);
check("5b 显示服务端人话回显（分钟口径）", /全程步行约 30 分钟（1800 米），在您定的 60 分钟以内/.test(afterHour), afterHour.match(/这条路线[^\n]*/)?.[0] ?? null);
check("5c 显示因果说明且用分钟说话", /超出你定的 60 分钟/.test(afterHour) && afterHour.includes("满陇桂雨"));
check("5d 新增高德调用 0 次", /本次重解新增高德调用：0 次/.test(afterHour));
check("5e 高亮跟着换到 1 小时", (await isSelected(page, "1 小时")) && !(await isSelected(page, "30 分钟")));

await page.getByRole("button", { name: /^不确定/ }).click();
await page.waitForTimeout(1800);
check("5f 选「不确定」：恰好多 1 次，maxWalkMinutes=null（不设上限）", A.resolveBodies.length === 3 && A.resolveBodies[2].maxWalkMinutes === null, A.resolveBodies.at(-1));
check("5g 「不确定」时回显写明没有设上限并给出步行分钟", /你没有设走路上限.*步行约 30 分钟/.test(await page.evaluate(() => document.body.innerText)));

/* 6. 失败分支：如实提示并给分钟建议，建议按钮能点 */
A.resolveMode = "fail";
// 调整页上「30 分钟」同时出现在步行上限和每站停留两组里，必须按组定位
const walkGroup = page.getByRole("group", { name: "全程步行上限" });
const stayGroup = page.getByRole("group", { name: "每站停留多久" });
await walkGroup.getByRole("button", { name: /^30 分钟/ }).click();
await page.waitForTimeout(1800);
const failText = await page.evaluate(() => document.body.innerText);
check("6 排不出时恰好多 1 次请求", A.resolveBodies.length === 4 && A.resolveBodies[3].maxWalkMinutes === 30, A.resolveBodies.at(-1));
check("6b 如实提示排不出并用分钟说", /放宽到 10 分钟可以排 2 站/.test(failText), failText.match(/[^\n]*放宽到[^\n]*/)?.[0] ?? null);
check("6c 出现「按 10 分钟 再试」按钮（分钟口径，不是米）", await page.getByRole("button", { name: /按 10 分钟 再试/ }).isVisible().catch(() => false));
A.resolveMode = "ok";
await page.getByRole("button", { name: /按 10 分钟 再试/ }).click();
await page.waitForTimeout(1800);
check("6d 点建议按钮会按 10 分钟重解", A.resolveBodies.length === 5 && A.resolveBodies[4].maxWalkMinutes === 10, A.resolveBodies.at(-1));

/* 7. 大字版：按分钟说「没有超过说好的 X」 */
await page.getByRole("tab", { name: "行程" }).click();
await page.waitForTimeout(500);
await page.getByRole("button", { name: /给爸妈看/ }).click();
await page.waitForTimeout(800);
const elderText = await page.getByRole("dialog").innerText().catch(() => "");
check("7 大字版按分钟判断：桩行程步行 30 分钟 > 说好的 10 分钟，应提示超出", /注意：这条路要走的时间超过了说好的 10 分钟/.test(elderText), elderText.match(/[^\n]*说好的[^\n]*/)?.[0] ?? null);
check("7b 大字版不再出现米数上限句式", !/说好的 \d+ 米/.test(elderText));
await page.getByRole("button", { name: "退出" }).click();
await page.waitForTimeout(300);
// 有路线后页面会去加载高德 JS 底图（webapi.amap.com）；请求已被本脚本拦截中止，没有真的发出。
// 这里只允许它这一个外网主机，出现任何别的外网请求都算失败。
const externalHosts = [...new Set(A.externalBlocked)];
/* 7c. 每站停留（D2）：只改停留时保留当前步行上限；账单写出「站数 × 每站分钟」；缓冲固定 */
await page.getByRole("tab", { name: "调整" }).click();
await page.waitForTimeout(500);
check("7c 调整页有「每站停留」一组四档，且写明缓冲 20 分钟固定", (await stayGroup.getByRole("button").count()) === 4 && (await stayGroup.innerText()).includes("缓冲 20 分钟固定"), await stayGroup.innerText().catch(() => ""));
check("7d 默认是每站 30 分钟", (await stayGroup.getByRole("button", { name: "30 分钟" }).getAttribute("aria-pressed")) === "true");
const beforeStay = A.resolveBodies.length;
await stayGroup.getByRole("button", { name: "60 分钟" }).click();
await page.waitForTimeout(1800);
check("7e 点每站 60 分钟：恰好多 1 次请求，带 stayMinutes=60，步行上限保持上一次的 10 分钟", A.resolveBodies.length === beforeStay + 1 && A.resolveBodies.at(-1).stayMinutes === 60 && A.resolveBodies.at(-1).maxWalkMinutes === 10, A.resolveBodies.at(-1));
const billText = await page.getByTestId("resolve-bill").innerText().catch(() => "");
check("7f 账单写出合计 = 步行 + 站数 × 每站分钟 + 缓冲（固定）", billText.includes("合计 170 / 240 分钟") && billText.includes("2 站 × 60 分钟 = 120 分钟") && billText.includes("缓冲 20 分钟（固定）"), billText);
check("7g 停留压站时显示说明", (await page.evaluate(() => document.body.innerText)).includes("每站停留 60 分钟时，半日 240 分钟里最多排 2 站"));
await walkGroup.getByRole("button", { name: /^1 小时/ }).click();
await page.waitForTimeout(1800);
check("7h 再改步行上限：带上刚选的每站 60 分钟", A.resolveBodies.at(-1).maxWalkMinutes === 60 && A.resolveBodies.at(-1).stayMinutes === 60, A.resolveBodies.at(-1));
await page.getByRole("tab", { name: "行程" }).click();
await page.waitForTimeout(500);
const routeText = await page.evaluate(() => document.body.innerText);
check("7i 行程页账单同样写「2 站 × 60 分钟」和「缓冲（固定）」", routeText.includes("2 站 × 60 分钟 = 120 分钟") && routeText.includes("缓冲（固定）"), routeText.match(/合计[^\n]*/)?.[0] ?? null);
check("7j 行程页不再出现「少走一点」按钮（D1）", (await page.getByRole("button", { name: /少走一点/ }).count()) === 0);

check("8 全程 0 弹窗；外网请求只有被拦截中止的高德 JS 底图加载器", dialogs.length === 0 && externalHosts.every((host) => host === "webapi.amap.com"), { dialogs, externalBlockedHosts: externalHosts });
const aDensity = await (async () => {
  await page.getByRole("tab", { name: "调整" }).click();
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const el = document.querySelector('[aria-label="爸妈能走多久"]');
    // 只量静态骨架：不含重解结果区块
    const buttons = el ? Array.from(el.querySelectorAll("button")).filter((b) => b.getBoundingClientRect().width > 0).length : -1;
    const text = el ? el.innerText : "";
    return { buttons, chars: text.replace(/\s+/g, "").length };
  });
})();
await contextA.close();

/* ═════════ 场景 B：答「不确定」→ 生成：不该发任何重解 ═════════ */
const B = makeStubs();
const contextB = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
await stubContext(contextB, B, { verifyAsFixture: true });
const pageB = await contextB.newPage();
await pageB.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await pageB.waitForTimeout(1200);
await pageB.getByRole("button", { name: /^不确定/ }).click();
await pageB.getByRole("button", { name: /生成我的路线/ }).click();
await pageB.waitForFunction(() => document.body.innerText.includes("桩站点A（夹具）"), null, { timeout: 15000 }).catch(() => {});
await pageB.waitForTimeout(1500);
check("9 答「不确定」后生成：核验 1 次、重解 0 次（核验给的就是不设上限的最优）", B.verifyCalls === 1 && B.resolveBodies.length === 0, { verifyCalls: B.verifyCalls, resolveCalls: B.resolveBodies.length });
await pageB.getByRole("tab", { name: "调整" }).click();
await pageB.waitForTimeout(500);
check("9b 调整页里「不确定」是高亮的", await isSelected(pageB, "不确定"));
await contextB.close();

/* ═════════ 场景 C：没回答直接生成：也不该发重解，且调整页没有任何一档被预先高亮 ═════════ */
const C = makeStubs();
const contextC = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
await stubContext(contextC, C, { verifyAsFixture: true });
const pageC = await contextC.newPage();
await pageC.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await pageC.waitForTimeout(1200);
await pageC.getByRole("button", { name: /生成我的路线/ }).click();
await pageC.waitForFunction(() => document.body.innerText.includes("桩站点A（夹具）"), null, { timeout: 15000 }).catch(() => {});
await pageC.waitForTimeout(1500);
await pageC.getByRole("tab", { name: "调整" }).click();
await pageC.waitForTimeout(500);
const noneSelectedC = (await Promise.all(OPTION_LABELS.map((label) => isSelected(pageC, label)))).every((value) => !value);
check("10 没回答直接生成：重解 0 次，调整页也没有任何一档被预先高亮", C.resolveBodies.length === 0 && noneSelectedC, { resolveCalls: C.resolveBodies.length });
await pageC.getByRole("group", { name: "每站停留多久" }).getByRole("button", { name: "45 分钟" }).click();
await pageC.waitForTimeout(1800);
const stillNoneC = (await Promise.all(OPTION_LABELS.map((label) => isSelected(pageC, label)))).every((value) => !value);
check("10b 没回答时只改每站停留：不设步行上限，也不会把步行一栏变成「不确定」", C.resolveBodies.length === 1 && C.resolveBodies[0].maxWalkMinutes === null && C.resolveBodies[0].stayMinutes === 45 && stillNoneC, { bodies: C.resolveBodies, stillNoneC });
await contextC.close();

/* ═════════ 场景 D：手机端：生成前的四个选项可见、不横向溢出 ═════════ */
const D = makeStubs();
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
await stubContext(mobile, D, { verifyAsFixture: false });
const mpage = await mobile.newPage();
await mpage.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await mpage.waitForTimeout(1200);
const overflow = await mpage.evaluate((labels) => {
  const doc = document.documentElement;
  const buttons = Array.from(document.querySelectorAll("button")).filter((b) => labels.some((l) => (b.textContent ?? "").startsWith(l)));
  const visible = buttons.filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  return {
    visibleButtons: visible.length,
    anyOverflow: visible.some((b) => b.getBoundingClientRect().right > doc.clientWidth + 1),
    pageOverflows: doc.scrollWidth > doc.clientWidth + 1,
    blockButtons: visible.length,
    blockChars: (() => {
      const first = visible[0];
      const block = first?.closest("div.mb-2\\.5");
      return block ? block.innerText.replace(/\s+/g, "").length : -1;
    })(),
  };
}, OPTION_LABELS);
check("11 手机端四个选项都可见且不横向溢出", overflow.visibleButtons === 4 && !overflow.anyOverflow && !overflow.pageOverflows, overflow);
await mpage.screenshot({ path: path.join(EVIDENCE, "preflight-mobile.png"), fullPage: false });

/* 11b. 手机端大字版：放大字号后顶部三个按钮仍各占一行文字，不会把「字小」拆成一字一行 */
await mpage.evaluate(([key, value]) => sessionStorage.setItem(key, value), ["xuxiake.session.route", JSON.stringify(FIXTURE_SNAPSHOT)]);
await mpage.reload({ waitUntil: "domcontentloaded" });
await mpage.waitForTimeout(1800);
await mpage.getByRole("button", { name: "行程与探索", exact: true }).click().catch(() => {});
await mpage.waitForTimeout(400);
await mpage.getByRole("button", { name: /给爸妈看/ }).click();
await mpage.waitForTimeout(600);
const elderHeader = async () => mpage.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return null;
  const doc = document.documentElement;
  const buttons = Array.from(dialog.querySelectorAll("button")).slice(0, 3);
  return buttons.map((button) => {
    const range = document.createRange();
    range.selectNodeContents(button);
    const lines = new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size;
    return { text: button.textContent, lines, right: Math.round(button.getBoundingClientRect().right), viewport: doc.clientWidth };
  });
});
const headerDefault = await elderHeader();
await mpage.getByRole("button", { name: "放大字号" }).click();
await mpage.getByRole("button", { name: "放大字号" }).click();
await mpage.getByRole("button", { name: "放大字号" }).click();
await mpage.waitForTimeout(300);
const headerLarge = await elderHeader();
const oneLine = (rows) => Array.isArray(rows) && rows.length === 3 && rows.every((row) => row.lines === 1 && row.right <= row.viewport + 1);
check("11b 手机端大字版默认字号：字小 / 字大 / 退出 都是一行文字，不溢出", oneLine(headerDefault), headerDefault);
check("11c 手机端大字版放到最大字号：三个按钮仍然各一行，不溢出", oneLine(headerLarge), headerLarge);
await mpage.screenshot({ path: path.join(EVIDENCE, "preflight-mobile-elder.png"), fullPage: false });
await mobile.close();

/* ═════════ 刷新恢复：已核验快照照常恢复（回归） ═════════ */
const E = makeStubs();
const contextE = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
await stubContext(contextE, E, { verifyAsFixture: false });
const pageE = await contextE.newPage();
await pageE.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await pageE.evaluate(([key, value]) => sessionStorage.setItem(key, value), ["xuxiake.session.route", JSON.stringify(FIXTURE_SNAPSHOT)]);
await pageE.reload({ waitUntil: "domcontentloaded" });
await pageE.waitForTimeout(2000);
const restored = await pageE.evaluate(() => document.body.innerText);
check("12 刷新后能恢复已核验路线（无崩溃），且没有因此多发重解", !restored.includes("couldn’t load") && restored.includes("桩站点A（夹具）") && E.resolveBodies.length === 0, { resolveCalls: E.resolveBodies.length });
await contextE.close();

await browser.close();

/* ═════════ 界面密度：新旧对比（旧值按旧源码的字面字符串，用同一份夹具数字算出，不是估的） ═════════ */
// 旧版「调整」面板的静态骨架（夹具：当前 2600 米，最长一段 1200 米 → 档位 1.7/2.2 公里、600/900 米）
const OLD_ADJUST_TEXT = [
  "爸妈能走多远？", "改上限不再花钱",
  "路线已经用高德实测过了。这里只按你选的距离重新排，不会再请求高德。 当前全程 2600 米。",
  "少走点", "约 1.7 公里", "稍微少点", "约 2.2 公里", "不设限", "能走多少算多少",
  "一口气最多走多远？", "现在最长的一段是 1200 米。总量再短，中间有一段走不动也不行。",
  "一小段", "≤ 600 米", "一段", "≤ 900 米", "不限", "只要能走就行",
  "只能调整「走多远」。要把没实测过的站加进来，需要另外付费补测，这里不会自动去测。",
].join("");
const OLD_PREFLIGHT_TEXT = [
  "爸妈大概能走多远？", "先定这条线，生成时就直接按它排，不用生成完再改。",
  "走不远", "约 2 公里", "一般", "约 3.5 公里", "能走", "不设限",
].join("");
const density = {
  note: "旧值 = 旧源码字面字符串按同一夹具数字拼出的字数；新值 = 浏览器里量的真实 DOM。字数不含空白。",
  adjustPage: { oldButtons: 6, oldChars: OLD_ADJUST_TEXT.length, newButtons: aDensity.buttons, newChars: aDensity.chars },
  beforeGenerate: { oldButtons: 3, oldChars: OLD_PREFLIGHT_TEXT.length, newButtons: overflow.blockButtons, newChars: overflow.blockChars },
};
console.log("\n界面密度（按钮数 / 字数）：", JSON.stringify(density));

const failed = results.filter((r) => !r.pass);
const allResolve = [...A.resolveBodies, ...B.resolveBodies, ...C.resolveBodies, ...D.resolveBodies, ...E.resolveBodies];
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: false,
  fixture: true,
  fixtureNotice: "拦截 /api/verify 与 /api/resolve 返回桩结果；只验证界面与接线，不代表真实路线或真实重解结果。",
  resolveCalls: allResolve.length,
  resolveBodies: A.resolveBodies,
  density,
  dialogs,
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "preflight-ui.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过（重解请求共 ${allResolve.length} 次，全部为桩）`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
