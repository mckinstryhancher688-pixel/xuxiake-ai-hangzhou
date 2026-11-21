/**
 * 前端减负验收（2026-11-16 改版；2026-11-20 加飞猪实景图与免费标注；2026-11-21 加讲解按站归属）：
 * 卡片去标签、审计归档、Tab 置顶、状态胶囊合并、mainPic/免费徽标/虚线时间轴、首页 hero、
 * 「我到了」的讲解与失败提示只挂在自己那一站、点击时把目标站 id 直接交给请求。
 *
 * 零付费：注入夹具快照，拦截一切 POST（含真的点了「我到了」那一次）。只验证视图层，不代表真实路线。
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
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const KEY = "xuxiake.session.route";
const AGENT_KEY = "xuxiake.session.agent";

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

async function open(vp, { withSnapshot = true, agentSnapshot = null } = {}) {
  const context = await browser.newContext({ viewport: vp, locale: "zh-CN" });
  if (withSnapshot) {
    await context.addInitScript(([k, v]) => sessionStorage.setItem(k, v), [KEY, JSON.stringify(FIXTURE_SNAPSHOT)]);
  }
  if (agentSnapshot) {
    await context.addInitScript(([k, v]) => sessionStorage.setItem(k, v), [AGENT_KEY, JSON.stringify(agentSnapshot)]);
  }
  let paidPosts = 0;
  let imageGets = 0;
  /** 被拦掉的 POST 长什么样：用来验证「点哪一站就买哪一站」，请求根本没出浏览器 */
  const blocked = [];
  await context.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      paidPosts += 1;
      blocked.push({ url: req.url(), body: req.postData() ?? null });
      return route.abort();
    }
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
  return { context, page, paid: () => paidPosts, images: () => imageGets, blocked: () => blocked };
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

/* ── 讲解不串站：第 1 站的讲解绝不显示在第 2 站卡片里 ──────────
   注入一份「到达过两站、但讲解只属于第 1 站」的智能体快照，选中第 2 站：
   修好之前第 2 站卡片会显示第 1 站的讲解（真实验收时用户就是这么发现的）。 */
const FIXTURE_AGENT = {
  token: null,
  pickedStopId: "b",
  arrivedStopIds: ["a", "b"],
  arrival: {
    ok: true,
    error: null,
    stopName: "桩站点A（夹具）",
    arrivalMode: "simulated",
    narration: {
      headline: "夹具讲解：只属于桩站点A",
      details: ["夹具细节"],
      nextSuggestion: "",
      degraded: false,
      rawText: "",
      numericAudit: { claims: [], matched: 0, unmatched: [] },
    },
    proof: null,
    token: null,
  },
  adjustment: null,
};
const n = await open({ width: 1440, height: 900 }, { agentSnapshot: FIXTURE_AGENT });
const cardsOf = () =>
  n.page.evaluate(() =>
    [...document.querySelectorAll("article")].map((a) => ({
      name: (a.querySelector("h4")?.textContent ?? "").trim(),
      hasNarration: a.innerText.includes("夹具讲解：只属于桩站点A"),
      buttons: [...a.querySelectorAll("button")].map((b) => b.textContent.trim()),
    })),
  );
let narrCards = await cardsOf();
const cardA = narrCards.find((c) => c.name.includes("桩站点A"));
const cardB = narrCards.find((c) => c.name.includes("桩站点B"));
check("24 选中第 2 站时，第 2 站卡片不显示第 1 站的讲解", cardB?.hasNarration === false, { b: cardB?.hasNarration });
check(
  "24b 第 2 站到过但没有自己的讲解：按钮仍是「我到了」",
  cardB?.buttons.includes("我到了") === true && !cardB.buttons.includes("我到了（再看一次）"),
  cardB?.buttons,
);
check("24c 第 1 站有自己的讲解：按钮是「再看一次」", cardA?.buttons.includes("我到了（再看一次）") === true, cardA?.buttons);
await n.page.locator("article", { hasText: "桩站点A（夹具）" }).getByRole("button", { name: "在地图定位" }).click();
await n.page.waitForTimeout(600);
narrCards = await cardsOf();
const cardA2 = narrCards.find((c) => c.name.includes("桩站点A"));
const cardB2 = narrCards.find((c) => c.name.includes("桩站点B"));
check(
  "24d 切到第 1 站后，讲解只出现在第 1 站卡片里",
  cardA2?.hasNarration === true && cardB2?.hasNarration === false,
  { a: cardA2?.hasNarration, b: cardB2?.hasNarration },
);
check("25 讲解这一段也是 0 次付费 POST", n.paid() === 0, { paid: n.paid() });
await n.context.close();

/* ── 点哪一站就买哪一站 ─────────────────────────────────────────
   修好之前：卡片按钮在同一次点击里既改选中站、又发请求，闭包里的 selectedStopId
   还是上一站，于是一个付费回合买到上一站的讲解，界面上什么都看不到（钱花了）。
   这里 POST 全部在浏览器边界被 abort，服务端连会话都不会建；
   再用 /api/agent 的 totalTurns 前后不变，证明这一段确实零付费。 */
const turnsBefore = (await (await fetch(`${BASE}/api/agent`)).json()).totalTurns;
const p = await open({ width: 1440, height: 900 });
const cardTextOf = () =>
  p.page.evaluate(() =>
    [...document.querySelectorAll("article")].map((a) => ({
      name: (a.querySelector("h4")?.textContent ?? "").trim(),
      text: a.innerText,
    })),
  );
// 默认选中的是第 1 站；不先切站，直接点第 2 站的「我到了」
await p.page.locator("article", { hasText: "桩站点B（夹具）" }).getByRole("button", { name: /^我到了$/ }).click();
await p.page.waitForTimeout(2000);
const agentPosts = p.blocked().filter((item) => item.url.includes("/api/agent"));
const sentStopId = agentPosts.length ? JSON.parse(agentPosts[0].body).stopId : null;
check("26 点第 2 站的「我到了」，请求里带的就是第 2 站（修好之前带的是第 1 站）", sentStopId === "b", { sentStopId });
check("26b 一次点击只发出一个回合，没有买两次", agentPosts.length === 1, { count: agentPosts.length });
let pCards = await cardTextOf();
check(
  "26c 这一回合的结果挂在第 2 站卡片里（这里是拦截造成的失败提示）",
  pCards.find((c) => c.name.includes("桩站点B"))?.text.includes("失败 · ") === true,
  { cardB: pCards.find((c) => c.name.includes("桩站点B"))?.text.slice(-120) },
);
await p.page.locator("article", { hasText: "桩站点A（夹具）" }).getByRole("button", { name: "在地图定位" }).click();
await p.page.waitForTimeout(800);
pCards = await cardTextOf();
check(
  "26d 切回第 1 站后，第 2 站那一次的失败提示不跟过来",
  pCards.find((c) => c.name.includes("桩站点A"))?.text.includes("失败 · ") === false,
  { cardA: pCards.find((c) => c.name.includes("桩站点A"))?.text.slice(-120) },
);
await p.page.screenshot({ path: path.join(EVIDENCE, "ui-density-arrive-target.png") });
const turnsAfter = (await (await fetch(`${BASE}/api/agent`)).json()).totalTurns;
check(
  "27 服务端回合数一步没动：POST 全部在浏览器边界被拦掉，这一段零付费",
  turnsAfter === turnsBefore,
  { before: turnsBefore, after: turnsAfter, blocked: p.blocked().length },
);
await p.context.close();

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
    "用来验证图片真的能加载、UNKNOWN 不会被当成免费；该图片请求是飞猪 CDN 的静态 GET，不计费。" +
    "「我到了」那一段真的点了按钮，但 POST 在浏览器边界就被 abort，服务端 totalTurns 前后不变（见 arriveTarget）。",
  tabs,
  imageGets: d.images(),
  arriveTarget: { sentStopId, blockedAgentPosts: agentPosts.length, turnsBefore, turnsAfter },
  screenshots: [
    "ui-density-route.png",
    "ui-density-audit.png",
    "ui-density-mobile.png",
    "ui-density-home.png",
    "ui-density-arrive-target.png",
  ],
  total: results.length,
  passed: results.length - failed.length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "ui-density-accept.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
