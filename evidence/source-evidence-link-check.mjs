/**
 * 飞猪优化① D：随机开 3 条真实原始链接，核对落地页与标注的 id/名称是否一致。
 * 跑法：先跑 source-evidence-paid-accept.mjs 产出 realStops，再 node evidence/source-evidence-link-check.mjs
 * 真实可见 Chromium 导航到飞猪原始 jumpUrl（不拦截外部请求），记录：
 *   - 重定向落地 URL 里的 poiId 是否等于标注 flyaiId（确定性身份核对）；
 *   - 落地页可见文本里是否出现标注名称（Flutter H5 壳页在桌面浏览器可能不渲染名称，如实记录）。
 * 只读取已产出的 realStops，不触发任何核验/几何/百炼付费调用；链接不含任何密钥。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const paid = JSON.parse(fs.readFileSync(path.join(EVIDENCE, "source-evidence-paid-accept.json"), "utf8"));
const stops = (paid.realStops ?? []).filter((s) => s.jumpUrl && s.flyaiId).slice(0, 3);

const CLI_CANDIDATES = [
  process.env.PLAYWRIGHT_CLI_PACKAGE,
  path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@playwright", "cli", "package.json"),
  path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@playwright", "cli", "package.json"),
  "/usr/local/lib/node_modules/@playwright/cli/package.json",
  "/usr/lib/node_modules/@playwright/cli/package.json",
].filter(Boolean);
function loadPlaywright() {
  for (const candidate of CLI_CANDIDATES) {
    try { return createRequire(candidate)("playwright"); } catch { /* 下一个 */ }
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

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const browser = await chromium.launch({ headless: false, executablePath: EXEC, args: ["--lang=zh-CN"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
const page = await context.newPage();
const links = [];

for (const stop of stops) {
  let finalUrl = "";
  let title = "";
  let bodyText = "";
  let httpStatus = null;
  try {
    const resp = await page.goto(stop.jumpUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    httpStatus = resp?.status() ?? null;
    await page.waitForTimeout(12000); // 给 Flutter/H5 壳页客户端渲染时间
    finalUrl = page.url();
    title = await page.title().catch(() => "");
    bodyText = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) || "";
  } catch (err) {
    finalUrl = page.url();
    bodyText = `导航异常：${String(err?.message ?? err).slice(0, 120)}`;
  }
  const poiId = /[?&]poiId=(\d+)/.exec(finalUrl)?.[1] ?? null;
  const idMatch = poiId === String(stop.flyaiId);
  const nameRendered = bodyText.includes(stop.name) || title.includes(stop.name);
  links.push({ name: stop.name, flyaiId: stop.flyaiId, finalUrl, poiId, idMatch, nameRendered, httpStatus, title: title.slice(0, 80), bodySample: bodyText.replace(/\s+/g, " ").slice(0, 160) });
  check(`「${stop.name}」原始链接落地 poiId 与标注 flyaiId 一致`, idMatch, { labeled: stop.flyaiId, landed: poiId, httpStatus });
  console.log(`     名称渲染：${nameRendered ? "落地页可见名称" : "桌面浏览器未渲染名称（Flutter H5 壳页，需飞猪 App 环境）"}；title=${JSON.stringify(title.slice(0, 60))}`);
  if (links.length === 1) {
    await page.screenshot({ path: path.join(EVIDENCE, "source-evidence-link-1.png"), fullPage: false }).catch(() => {});
  }
}

await browser.close();

const idMatches = links.filter((l) => l.idMatch).length;
const nameRenders = links.filter((l) => l.nameRendered).length;
check("3 条原始链接全部确定性命中各自标注的飞猪 poiId", links.length === 3 && idMatches === 3, { idMatches, total: links.length });

const summary = {
  checkedAt: new Date().toISOString(),
  paid: false,
  note: "真实可见 Chromium 导航飞猪原始链接；poiId 经重定向链确定性核对。名称是否渲染取决于飞猪 Flutter H5 在桌面浏览器的可用性，如实记录，不据此伪造一致性。",
  source: "source-evidence-paid-accept.json realStops",
  total: results.length,
  passed: results.length - results.filter((r) => !r.pass).length,
  idMatches,
  nameRenders,
  links,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "source-evidence-link-check.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过（id 命中 ${idMatches}/3，名称渲染 ${nameRenders}/3）`);
process.exit(results.some((r) => !r.pass) ? 1 : 0);