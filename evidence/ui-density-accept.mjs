/**
 * 前端减负验收（2026-11-16 改版；2026-11-20 加飞猪实景图与免费标注）：
 * 卡片去标签、审计归档、Tab 置顶、状态胶囊合并、mainPic/免费徽标/虚线时间轴、首页 hero。
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

/**
 * 只放行飞猪 CDN 的静态实景图（GET，不计费）；其余外网一律拦掉。
 * 所有 POST 仍然全部拦死并计数，保证零付费。
 */
const IMAGE_HOSTS = new Set(["img.alicdn.com"]);

async function open(vp, { withSnapshot = true } = {}) {
  const context = await browser.newContext({ viewport: vp, locale: "zh-CN" });
  if (withSnapshot) {
    await context.addInitScript(([k, v]) => sessionStorage.setItem(k, v), [KEY, JSON.stringify(FIXTURE_SNAPSHOT)]);
  }
  let paidPosts = 0;
  let imageGets = 0;
  await context.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "POST") { paidPosts += 1; return route.abort(); }
    try {
      const url = new URL(req.url());
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return route.continue();
      if (IMAGE_HOSTS.has(url.hostname)) { imageGets += 1; return route.continue(); }
    } catch { /* ignore */ }
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);
  return { context, page, paid: () => paidPosts, images: () => imageGets };
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

/* ── 飞猪实景图与「免费」标注 ───────────────────────────── */
const photos = await d.page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-testid="stop-photo"]')).map((node) => {
    const img = node.querySelector("img");
    return {
      hasImg: Boolean(img),
      src: img ? img.getAttribute("src") : null,
      loaded: img ? img.naturalWidth > 0 : false,
      placeholder: node.querySelector('[role="img"]')?.getAttribute("aria-label") ?? null,
    };
  }),
);
check("19 每一站都有一个图位（夹具 2 站 → 2 个）", photos.length === 2, photos);
check(
  "19b 飞猪没给图时画占位块（写明「飞猪未返回实景图」），不塞假照片",
  photos[0]?.hasImg === false && Boolean(photos[0]?.placeholder?.includes("飞猪未返回实景图")),
  photos[0],
);
check(
  "19c 飞猪给了 mainPic 就真把实景图画出来（真的加载成功）",
  photos[1]?.hasImg === true && photos[1]?.loaded === true && /^https:\/\/img\.alicdn\.com\//.test(photos[1]?.src ?? ""),
  photos[1],
);

const cards = await d.page.evaluate(() =>
  Array.from(document.querySelectorAll("article")).map((card) => ({
    name: card.querySelector("h4")?.textContent ?? "",
    free: card.querySelector('[data-testid="free-badge"]')?.textContent ?? null,
    serifName: getComputedStyle(card.querySelector("h4") ?? document.body).fontFamily,
  })),
);
check("20 「免费」只出现在飞猪标了 FREE 的那一站", cards.filter((c) => c.free).length === 1 && cards[0]?.free?.includes("免费"), cards.map((c) => ({ name: c.name, free: c.free })));
check("20b UNKNOWN 不当成免费（第二站没有徽标）", cards[1]?.free === null, cards[1]?.free);
check("20c 「免费」旁边标明来源是飞猪", cards[0]?.free?.includes("飞猪") === true, cards[0]?.free);
check("20d 站名用宋体（新中式编辑感）", /Songti|SimSun|Noto Serif|STSong|serif/.test(cards[0]?.serifName ?? ""), cards[0]?.serifName);

/* ── 虚线时间轴 + 实测步行 chip ─────────────────────────── */
const legs = await d.page.evaluate(() => {
  const lines = Array.from(document.querySelectorAll('[data-testid="leg-line"]'));
  const chips = Array.from(document.querySelectorAll('[data-testid="leg-chip"]'));
  return {
    lines: lines.length,
    dashed: lines.every((line) => getComputedStyle(line).borderLeftStyle === "dashed"),
    chips: chips.map((chip) => chip.textContent?.replace(/\s+/g, " ").trim() ?? ""),
  };
});
check("21 两站之间有虚线时间轴", legs.lines === 2 && legs.dashed, { lines: legs.lines, dashed: legs.dashed });
check(
  "21b 步行段写明「高德实测步行」与距离分钟",
  legs.chips.length === 2 && legs.chips.every((text) => /高德实测步行 (1\.2 公里|\d+ 米) · 约 \d+ 分钟/.test(text)),
  legs.chips,
);

/* ── 巨型横幅与常驻说明已删 ─────────────────────────────── */check("9 没有置顶的「我到了」大横幅", await d.page.locator("section", { hasText: "在场探索 · 百炼托管智能体" }).count() === 0);
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

/* ── 首页（还没有路线）：一句提问 + 一张说明卡，不默认打开地图 ── */
const h = await open({ width: 1440, height: 900 }, { withSnapshot: false });
const homeText = await h.page.evaluate(() => document.body.innerText);
check("22 首页有宋体大标题，说清是陪爸妈慢逛", /陪爸妈慢逛/.test(homeText) && homeText.includes("一段一段都实测过"));
check("22b 首页写清两个来源：飞猪实景图文 × 高德实测步行路网", homeText.includes("飞猪实景图文") && homeText.includes("高德实测步行路网"));
check("22c 首页只有一个问题：爸妈全程一共能走多久", homeText.includes("爸妈全程一共能走多久"));
check("22d 首页不默认打开地图（没有「地图」分页，也没有示意图）", (await h.page.getByRole("button", { name: "地图", exact: true }).count()) === 0 && !homeText.includes("示意图"));
await h.page.screenshot({ path: path.join(EVIDENCE, "ui-density-home.png"), fullPage: false });
check("23 首页这一段也是 0 次付费 POST", h.paid() === 0, { paid: h.paid() });
await h.context.close();

await browser.close();

const failed = results.filter((r) => !r.pass);
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: false,
  fixture: true,
  fixtureNotice:
    "注入夹具快照、拦截一切 POST；只验证视图层信息密度与层级，不代表真实路线。" +
    "例外：第二站的实景图与 freePoiStatus=UNKNOWN 取自真实 /api/discover 返回（见 flyai-photo-accept.json），" +
    "用来验证图片真的能加载、UNKNOWN 不会被当成免费；该图片请求是飞猪 CDN 的静态 GET，不计费。",
  tabs,
  imageGets: d.images(),
  screenshots: ["ui-density-route.png", "ui-density-audit.png", "ui-density-mobile.png", "ui-density-home.png"],
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "ui-density-accept.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
