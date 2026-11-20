/**
 * 前端减负验收（2026-11-16 改版）：卡片去标签、审计归档、Tab 置顶、状态胶囊合并。
 *
 * 零付费：注入夹具快照，拦截一切 POST。只验证视图层，不代表真实路线。
 * 跑法：先 npm run build && npm run start，再 node evidence/ui-density-accept.mjs
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
const KEY = "xuxiake.session.route";

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

const browser = await chromium.launch({ headless: false, executablePath: EXEC, args: ["--lang=zh-CN"] });

async function open(vp) {
  const context = await browser.newContext({ viewport: vp, locale: "zh-CN" });
  await context.addInitScript(([k, v]) => sessionStorage.setItem(k, v), [KEY, JSON.stringify(FIXTURE_SNAPSHOT)]);
  let paidPosts = 0;
  await context.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "POST") { paidPosts += 1; return route.abort(); }
    try {
      const h = new URL(req.url()).hostname;
      if (h === "localhost" || h === "127.0.0.1") return route.continue();
    } catch { /* ignore */ }
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);
  return { context, page, paid: () => paidPosts };
}

/* ── 桌面：三个 Tab 在右栏顶部，大字版入口与之并列 ───────────── */
const d = await open({ width: 1440, height: 900 });
const tabs = await d.page.getByRole("tab").allTextContents();
check("1 顶部分页是「行程 / 调整 / 核验明细」", tabs.join(",") === "行程,调整,核验明细", tabs);
check("1b 分页里不再叫「更多」", !tabs.includes("更多"));

const elderBtn = d.page.getByRole("button", { name: /给爸妈看/ });
check("2 「给爸妈看」与分页并列在右栏顶部", await elderBtn.isVisible().catch(() => false));

/* ── 卡片去标签 ─────────────────────────────────────────── */
const cardText = await d.page.evaluate(() => document.body.innerText);
const FORBIDDEN = ["来源 FlyAI", "查询于", "✓已校验", "已匹配", "Asia/Shanghai", "POI 200303", "高德 杭州市"];
for (const term of FORBIDDEN) {
  check(`3 行程卡片不含「${term}」`, !cardText.includes(term), { found: cardText.includes(term) });
}

/* ── 卡片该有的仍然有 ───────────────────────────────────── */
check("4 卡片保留站名", cardText.includes("桩站点A（夹具）"));
check("5 卡片保留停留时长", /停留 \d+ 分钟/.test(cardText));
check("6 卡片保留营业状态", /营业|开放/.test(cardText));
check("7 卡片保留无障碍洗手间（夹具里有）", cardText.includes("无障碍洗手间"));

/* ── 「我到了」内嵌在卡片 ───────────────────────────────── */
const arriveBtns = await d.page.getByRole("button", { name: /^我到了$/ }).count();
check("8 「我到了」内嵌在每一站（夹具 2 站 → 2 个按钮）", arriveBtns === 2, { count: arriveBtns });
check("8b 已到达的站改成「我到了（再看一次）」不重复计数", (await d.page.getByRole("button", { name: /再看一次/ }).count()) === 0);

/* ── 巨型横幅与常驻说明已删 ─────────────────────────────── */
check("9 没有置顶的「我到了」大横幅", await d.page.locator("section", { hasText: "在场探索 · 百炼托管智能体" }).count() === 0);
check("10 行程页没有常驻的「数据可信说明」大块", !cardText.includes("地板价") && !cardText.includes("绝不用常识补数字"));

/* ── 顶栏单一胶囊 ───────────────────────────────────────── */
const badge = d.page.getByRole("button", { name: /真实路网核验/ });
check("11 顶栏只有一个「✓ 真实路网核验」标识", await badge.isVisible().catch(() => false));
check("11b 顶栏不再并列「预算余」胶囊", !cardText.includes("预算余"));

console.log("→ 点顶栏胶囊");
await badge.click();
await d.page.waitForTimeout(500);
const dialog = d.page.getByRole("dialog", { name: "数据可信说明" });
check("12 点胶囊能打开说明弹窗", await dialog.isVisible().catch(() => false));
const dlgText = await dialog.innerText();
check("12b 弹窗里写明「不含价格」", dlgText.includes("价格"));
check("12c 弹窗里写明「绝不用常识补数字」", dlgText.includes("绝不用常识补数字"));
console.log("→ 关闭弹窗");
await dialog.getByRole("button", { name: "关闭" }).click();
await d.page.waitForTimeout(300);
check("12d 能关闭弹窗", !(await dialog.isVisible().catch(() => false)));

await d.page.screenshot({ path: path.join(EVIDENCE, "ui-density-route.png"), fullPage: false });

/* ── 核验明细页收了审计信息 ─────────────────────────────── */
console.log("→ 切到核验明细");
const auditTab = d.page.getByRole("tab", { name: "核验明细" });
await auditTab.scrollIntoViewIfNeeded();
await auditTab.click();
await d.page.waitForTimeout(600);
const auditText = await d.page.evaluate(() => document.body.innerText);
check("13 核验明细页有原始核验记录", auditText.includes("原始核验记录"));
check("13b 核验明细页有本次调用统计", /地点请求 \d+ 次/.test(auditText));
check("13c 核验明细页有坐标系判定折叠框", auditText.includes("坐标系判定"));
check("13d 核验明细页有洗手间口径说明", auditText.includes("不代表整条路线无障碍"));
check("13e 行程页里不再出现「原始核验记录」", !cardText.includes("原始核验记录"));
await d.page.screenshot({ path: path.join(EVIDENCE, "ui-density-audit.png"), fullPage: false });

/* ── 地图底部黑条已删 ───────────────────────────────────── */
check("14 地图不再显示技术性的底图说明", !auditText.includes("JS API 2.0") && !auditText.includes("手绘示意（真实地图未启用）"));
check("14b 不是真实地图时仍如实标注「示意图」", auditText.includes("示意图，非真实地图") || auditText.includes("真实地图"));

/* ── 体力评估器（调整页） ─────────────────────────────── */
await d.page.getByRole("tab", { name: "调整" }).click();
await d.page.waitForTimeout(600);
const meter = d.page.locator('[aria-label="爸妈体力评估"]');
check("17 调整页有体力评估器", (await meter.count()) === 1);
const meterText = await meter.innerText();
check("17b 两条都在：全程走路 / 一口气能走", meterText.includes("全程走路") && meterText.includes("一口气能走"));
check("17c 显示已用与上限的关系", /已用 \d+ (分钟|米)/.test(meterText), meterText.split("\n").slice(0, 3).join(" | "));
check("17d 未设上限时不画满格进度条", (await meter.getByRole("progressbar").count()) === 0, { bars: await meter.getByRole("progressbar").count() });

/* ── 主界面不再有技术调试面板 ───────────────────────────── */
await d.page.getByRole("tab", { name: "核验明细" }).click();
await d.page.waitForTimeout(500);
const techText = await d.page.evaluate(() => document.body.innerText);
check("18 主界面没有调试面板", !techText.includes("开发调试面板") && !techText.includes("原始 JSON"));
check("18b 主界面没有 LIVE / MOCK 字样", !/LIVE|MOCK/.test(techText));

/* ── 手机端 ─────────────────────────────────────────────── */
const m = await open({ width: 390, height: 844 });
await m.page.getByRole("button", { name: "行程与探索", exact: true }).click().catch(() => {});
await m.page.waitForTimeout(1000);
const mOverflow = await m.page.evaluate(() => {
  const doc = document.documentElement;
  return { pageOverflows: doc.scrollWidth > doc.clientWidth + 1 };
});
check("15 手机端无横向溢出", !mOverflow.pageOverflows, mOverflow);
await m.page.screenshot({ path: path.join(EVIDENCE, "ui-density-mobile.png"), fullPage: false });

check("16 全程 0 次付费 POST", d.paid() + m.paid() === 0, { desktop: d.paid(), mobile: m.paid() });

await m.context.close();
await d.context.close();
await browser.close();

const failed = results.filter((r) => !r.pass);
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: false,
  fixture: true,
  fixtureNotice: "注入夹具快照、拦截一切 POST；只验证视图层信息密度与层级，不代表真实路线。",
  tabs,
  screenshots: ["ui-density-route.png", "ui-density-audit.png", "ui-density-mobile.png"],
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "ui-density-accept.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
