/**
 * 首页「也可以直接说」输入框的零付费 UI 验证。
 *
 * /api/understand 在网络层拦截：桩响应里的 understanding 由真实的 judgeModelReply 从手写的「模型回复」算出，
 * 所以界面拿到的形状与服务端完全一致；但这些「模型回复」是手写的，不代表千问的真实表现。
 * /api/verify、/api/resolve 也返回桩，其余付费端点与外网一律拦截。零真实调用。
 * 跑法（需先 npm run build && npm run start）：
 *   node --import ./evidence/register-alias.mjs evidence/understand-ui.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { FIXTURE_REPORT } from "./preflight-fixture.mjs";

const { judgeModelReply, fallbackUnderstanding } = await import("../src/lib/understand.ts");

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

/** 手写的「模型回复」：只用来驱动真实的校验代码，不代表模型真实输出 */
const MODEL_REPLIES = {
  "我妈膝盖不好": { kind: "ask", quote: "", question: "阿姨膝盖不好，全程一共大概能走多久？", other: [] },
  "我妈全程最多走一个小时": { kind: "total", quote: "全程最多走一个小时", question: "", other: [] },
  "全程最多走45分钟": { kind: "total", quote: "全程最多走45分钟", question: "", other: [] },
  "我妈走半小时就得歇": { kind: "total", quote: "走半小时", question: "", other: [] },
  "想去断桥看看": { kind: "off-topic", quote: "", question: "", other: ["想去断桥看看"] },
};

const understandBodies = [];
const resolveBodies = [];
const verifyCalls = { count: 0 };
const externalHosts = new Set();

function understandStub(text) {
  if (text === "坏掉的一句") {
    return { ok: true, understanding: fallbackUnderstanding("百炼返回错误 401"), degraded: true, error: "百炼返回 HTTP 401 InvalidApiKey", model: "qwen-flash", cost: { modelCalls: 1, inputTokens: 0, outputTokens: 0 } };
  }
  const reply = MODEL_REPLIES[text];
  const understanding = reply ? judgeModelReply(text, JSON.stringify(reply)) : fallbackUnderstanding("桩里没有这句话");
  return { ok: true, understanding, degraded: understanding.source === "fallback", error: null, model: "qwen-flash", cost: { modelCalls: 1, inputTokens: 420, outputTokens: 30 } };
}

function resolveStub(body) {
  const minutes = body.maxWalkMinutes ?? null;
  return {
    ok: true,
    cost: { newAmapCalls: 0 },
    execution: { allowed: true, reason: "桩" },
    explanation: {
      totalWalkMeters: 1800, totalWalkMinutes: 30, limit: null, limitMinutes: minutes,
      withinLimit: true, withinMinutesLimit: true, longestSegmentMeters: 900, segmentLimit: null,
      withinSegmentLimit: true, verdict: "桩回显", whyDropped: [], keptBecauseMust: [],
      withoutLimit: null,
    },
    itinerary: { ...FIXTURE_REPORT.itinerary, totalWalkMeters: 1800, totalWalkMinutes: 30, totalMinutes: 50 },
    note: "桩",
  };
}

async function stubContext(context) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "POST" && /\/api\/understand/.test(url)) {
      const body = JSON.parse(req.postData() ?? "{}");
      understandBodies.push(body);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(understandStub(body.text)) });
    }
    if (req.method() === "POST" && /\/api\/resolve/.test(url)) {
      const body = JSON.parse(req.postData() ?? "{}");
      resolveBodies.push(body);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resolveStub(body)) });
    }
    if (req.method() === "POST" && /\/api\/verify/.test(url)) {
      verifyCalls.count += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ report: FIXTURE_REPORT, categories: ["自然风光"] }) });
    }
    if (req.method() === "POST" && /\/api\/(discover|route-geometry|agent|plan)/.test(url)) return route.abort();
    try {
      const host = new URL(url).hostname;
      if (host === "localhost" || host === "127.0.0.1") return route.continue();
      externalHosts.add(host);
    } catch { /* ignore */ }
    return route.abort();
  });
}

const OPTION_LABELS = ["30 分钟", "1 小时", "1.5 小时", "不确定"];
const isSelected = async (page, label) =>
  ((await page.getByRole("button", { name: new RegExp(`^${label}`) }).first().getAttribute("class")) ?? "")
    .split(/\s+/)
    .includes("border-brand-600");
const selectedLabels = async (page) => {
  const out = [];
  for (const label of OPTION_LABELS) if (await isSelected(page, label)) out.push(label);
  return out;
};
const questionText = (page) => page.getByTestId("preflight-question").innerText();
const noteText = (page) => page.getByTestId("preflight-note").innerText().catch(() => "");

async function say(page, text, { enter = false } = {}) {
  const input = page.getByRole("textbox", { name: "说说爸妈的情况" });
  await input.fill(text);
  if (enter) await input.press("Enter");
  else await page.getByRole("button", { name: "读一下" }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("正在读…"), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
}

const browser = await chromium.launch({ headless: process.env.HEADED !== "1", executablePath: EXEC, args: ["--lang=zh-CN"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
await stubContext(context);
const page = await context.newPage();
const dialogs = [];
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1500);

/* 1. 首页：输入框与按钮都在，空着时按钮不可点，不发请求 */
const input = page.getByRole("textbox", { name: "说说爸妈的情况" });
check("1 首页有「说说爸妈的情况」输入框", await input.isVisible());
check("1b 占位提示给了一个例子", ((await input.getAttribute("placeholder")) ?? "").includes("我妈膝盖不好"));
check("1c 没输入时「读一下」不可点", await page.getByRole("button", { name: "读一下" }).isDisabled());
check("1d 打开首页不发 /api/understand", understandBodies.length === 0);
check("1e 标题是默认问题", (await questionText(page)).startsWith("爸妈全程一共能走多久？"));

/* 2. 只说身体情况 → 标题换成追问，选项不变、不替用户选 */
await say(page, "我妈膝盖不好");
check("2 读一下恰好发 1 次请求，原话原样发出", understandBodies.length === 1 && understandBodies[0].text === "我妈膝盖不好", understandBodies);
const q2 = await questionText(page);
check("2b 标题换成模型写的追问，并标明是按情况追问的", q2.includes("阿姨膝盖不好，全程一共大概能走多久？") && q2.includes("按您说的情况追问"), q2);
check("2c 选项还是那四个，且没有任何一个被替用户选上", (await selectedLabels(page)).length === 0);
check("2d 如实写出调用了百炼 1 次", (await noteText(page)).includes("调用百炼 1 次"), await noteText(page));
await page.getByRole("button", { name: /^30 分钟/ }).click();
check("2e 追问之后点选项照常生效", (await selectedLabels(page)).join() === "30 分钟");

/* 3. 一口气 ≠ 全程：即使「模型」说是全程，界面也不能把 30 分钟当成全程上限 */
await page.getByRole("button", { name: /^不确定/ }).click();
await say(page, "我妈走半小时就得歇");
check("3 「走半小时就得歇」不会被选成 30 分钟", !(await isSelected(page, "30 分钟")), await selectedLabels(page));
check("3b 说明讲清这像是一口气、问的是全程", /一口气/.test(await noteText(page)), await noteText(page));

/* 4. 明确的全程时长 → 自动选上，并复述原话（回车也能提交） */
await say(page, "我妈全程最多走一个小时", { enter: true });
check("4 回车也能提交，恰好再多 1 次请求", understandBodies.length === 3, understandBodies.length);
check("4b 自动选上 1 小时", (await selectedLabels(page)).join() === "1 小时", await selectedLabels(page));
check("4c 复述原话：按您说的「…」，定为 1 小时", (await noteText(page)).includes("按您说的「全程最多走一个小时」，定为 1 小时。"), await noteText(page));
check("4d 标题回到默认问题（不再是追问）", !(await questionText(page)).includes("按您说的情况追问"));

/* 5. 菜单外的时长（45 分钟）→ 出现一个「您说的」选项并选中 */
await say(page, "全程最多走45分钟");
const custom = page.getByRole("button", { name: /45 分钟/ });
check("5 出现「45 分钟 · 您说的」并处于选中态", await custom.isVisible().catch(() => false) && ((await custom.getAttribute("class")) ?? "").split(/\s+/).includes("border-brand-600"));
check("5b 菜单里的四个都没被选上", (await selectedLabels(page)).length === 0, await selectedLabels(page));

/* 6. 没读成 → 退回默认问题，原因写出来 */
await say(page, "坏掉的一句");
check("6 没读成时写明原因并让用户直接选", /这次没读成这句话（百炼返回错误 401），请直接选一个/.test(await noteText(page)), await noteText(page));
check("6b 没读成不改用户已经选的（还是 45 分钟）", await custom.isVisible().catch(() => false));

/* 7. 没讲走路 → 如实说这一版只看能走多久；其它要求逐字列出来 */
await say(page, "想去断桥看看");
const n7 = await noteText(page);
check("7 没讲走路时说明这一版只按能走多久排", n7.includes("这一版只按「爸妈全程能走多久」来排路线"), n7);
check("7b 「想去断桥看看」如实列为这一版还用不上", n7.includes("「想去断桥看看」这一版还用不上"), n7);
await page.screenshot({ path: path.join(EVIDENCE, "understand-desktop.png"), fullPage: false });

/* 8. 用「45 分钟」生成：核验后按 45 分钟重解；调整页也显示「您说的 45 分钟」 */
await say(page, "全程最多走45分钟");
await page.getByRole("button", { name: /生成我的路线/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("桩站点A（夹具）"), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
check("8 生成后按您说的 45 分钟重解 1 次", verifyCalls.count === 1 && resolveBodies.length === 1 && resolveBodies[0].maxWalkMinutes === 45, resolveBodies);
await page.getByRole("tab", { name: "调整" }).click();
await page.waitForTimeout(600);
const panelText = await page.getByRole("region", { name: "爸妈能走多久" }).innerText().catch(() => "");
check("8b 调整页显示「45 分钟 · 您说的」", /45 分钟\s*您说的/.test(panelText), panelText.slice(0, 160));

const homeDensity = await (async () => {
  const p = await context.newPage();
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  const d = await p.evaluate(() => {
    const block = document.querySelector('[aria-label="爸妈全程能走多久"]');
    if (!block) return null;
    const buttons = Array.from(block.querySelectorAll("button")).filter((b) => b.getBoundingClientRect().width > 0).length;
    const inputs = block.querySelectorAll("input").length;
    return { buttons, inputs, chars: block.innerText.replace(/\s+/g, "").length };
  });
  await p.close();
  return d;
})();
await context.close();

/* 9. 手机端：输入框和按钮在 390 宽度下不溢出 */
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
await stubContext(mobile);
const mpage = await mobile.newPage();
await mpage.goto(BASE, { waitUntil: "domcontentloaded" });
await mpage.waitForTimeout(1200);
await say(mpage, "我妈膝盖不好");
const overflow = await mpage.evaluate(() => {
  const doc = document.documentElement;
  const block = document.querySelector('[aria-label="爸妈全程能走多久"]');
  const els = block ? Array.from(block.querySelectorAll("button, input")) : [];
  const generate = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("生成我的路线"));
  const g = generate?.getBoundingClientRect();
  return {
    controls: els.length,
    anyOverflow: els.some((el) => el.getBoundingClientRect().right > doc.clientWidth + 1),
    pageOverflows: doc.scrollWidth > doc.clientWidth + 1,
    generateVisible: Boolean(g && g.bottom <= window.innerHeight && g.top >= 0),
  };
});
check("9 手机端输入框、按钮、选项都不横向溢出，「生成我的路线」仍在屏内", overflow.controls >= 6 && !overflow.anyOverflow && !overflow.pageOverflows && overflow.generateVisible, overflow);
await mpage.screenshot({ path: path.join(EVIDENCE, "understand-mobile.png"), fullPage: false });
await mobile.close();
await browser.close();

check("10 全程 0 弹窗；外网请求只有被拦截中止的高德 JS 底图加载器", dialogs.length === 0 && [...externalHosts].every((h) => h === "webapi.amap.com"), { dialogs, externalHosts: [...externalHosts] });

/* 首页那一块的密度：旧值来自上一版 preflight-ui.json 的实测（4 个按钮、67 字、0 个输入框） */
const density = { before: { buttons: 4, inputs: 0, chars: 67, source: "evidence/preflight-ui.json（加输入框之前的实测）" }, after: homeDensity };
console.log("\n首页那一问的密度：", JSON.stringify(density));

const failed = results.filter((r) => !r.pass);
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: false,
  fixture: true,
  fixtureNotice: "拦截 /api/understand、/api/verify、/api/resolve 返回桩；understanding 由真实 judgeModelReply 从手写模型回复算出，不代表千问真实表现。",
  understandBodies,
  resolveBodies,
  density,
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "understand-ui.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过（/api/understand 请求 ${understandBodies.length} 次，全部为桩）`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
