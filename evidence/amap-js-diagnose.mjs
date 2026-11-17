/**
 * 高德 JS API 底图加载诊断（只读，零高德业务调用）。
 *
 * 用真实浏览器打开首页，不拦截任何高德请求，记录：
 *   1. 浏览器去 webapi.amap.com 加载 SDK 脚本的结果（状态码、是否被平台拒绝）；
 *   2. 页面上 SDK 加载失败时的真实错误文字；
 *   3. 控制台里与高德有关的报错。
 * 输出里的 key 与 jscode 全部替换成 <hidden>，不会把密钥打印到日志或 JSON 里。
 * 只加载页面和 SDK 脚本，不触发搜索、步行、核验或百炼调用。
 *
 * 跑法（服务需已 build + start）：node evidence/amap-js-diagnose.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

/** 去掉 key / jscode / 任何看起来像密钥的查询参数值 */
const redact = (text) =>
  String(text)
    // URL 查询参数
    .replace(/([?&](?:key|jscode|securityJsCode)=)[^&\s"']+/gi, "$1<hidden>")
    // JSON 字段：SDK 的 ___onAPILoaded 回包里有 "key" 与 "sec_code"，都不能落盘
    .replace(/"(key|jscode|securityJsCode|sec_code|sec_code_debug)"\s*:\s*"[^"]*"/gi, '"$1":"<hidden>"')
    .replace(/(jscode|securityJsCode)["']?\s*[:=]\s*["']?[^"'\s,}&]+/gi, "$1=<hidden>");

// 地图只在「有路线」时才渲染，所以注入一份夹具路线让它出现（与 preflight-ui 同一份，不是真实核验结果）。
// 同时拦截所有会花钱或会改状态的 POST：核验、几何补查、重解、百炼、协商、飞猪。SDK 脚本本身走真实网络。
const { FIXTURE_SNAPSHOT } = await import("./preflight-fixture.mjs");
const SNAPSHOT_KEY = "xuxiake.session.route";

const browser = await chromium.launch({ headless: process.env.HEADED !== "1", executablePath: EXEC, args: ["--lang=zh-CN"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
const blockedPosts = [];
await context.route("**/*", async (route) => {
  const req = route.request();
  if (req.method() === "POST" && /\/api\/(verify|route-geometry|resolve|understand|agent|plan|discover)/.test(req.url())) {
    blockedPosts.push(new URL(req.url()).pathname);
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "诊断脚本已拦截付费或改状态的请求" }) });
  }
  return route.continue();
});
const page = await context.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), [SNAPSHOT_KEY, JSON.stringify(FIXTURE_SNAPSHOT)]);

const sdkResponses = [];
const proxyResponses = [];
const consoleErrors = [];
const requestFailures = [];

page.on("response", async (response) => {
  const url = response.url();
  if (/webapi\.amap\.com|restapi\.amap\.com/.test(url)) {
    let snippet = "";
    try {
      snippet = redact((await response.text()).slice(0, 300));
    } catch { /* 有的响应没有正文 */ }
    sdkResponses.push({ url: redact(url).slice(0, 160), status: response.status(), snippet });
  }
  if (/_AMapService|amap-proxy/.test(url)) {
    proxyResponses.push({ url: redact(url).slice(0, 160), status: response.status() });
  }
});
page.on("console", (message) => {
  if (message.type() !== "error" && message.type() !== "warning") return;
  const text = redact(message.text());
  if (/amap|高德|INVALID|USER_|SCODE|DOMAIN|key/i.test(text)) consoleErrors.push(text.slice(0, 300));
});
page.on("requestfailed", (request) => {
  if (/amap\.com/.test(request.url())) {
    requestFailures.push({ url: redact(request.url()).slice(0, 160), error: request.failure()?.errorText ?? "unknown" });
  }
});

await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
// SDK 加载是异步的：等它成功或失败都会留下痕迹
await page.waitForTimeout(9000);

const pageText = await page.evaluate(() => document.body.innerText);
const mapFailureLine = pageText
  .split("\n")
  .find((line) => /高德|JS API|底图|Key|安全密钥|加载失败|脚本请求/.test(line))?.slice(0, 300) ?? null;
const mapReady = await page.evaluate(() => Boolean(window.AMap));

await page.screenshot({ path: path.join(ROOT, "evidence", "amap-js-diagnose.png"), fullPage: false });
await browser.close();

const scriptCalls = sdkResponses.filter((item) => /webapi\.amap\.com\/maps/.test(item.url));
const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: false,
  amapBusinessCalls: 0,
  mapReady,
  sdkScriptCalls: scriptCalls,
  sdkResponses: sdkResponses.slice(0, 12),
  proxyResponses: proxyResponses.slice(0, 12),
  requestFailures,
  consoleErrors: [...new Set(consoleErrors)].slice(0, 12),
  pageMapMessage: mapFailureLine,
};
fs.writeFileSync(path.join(ROOT, "evidence", "amap-js-diagnose.json"), JSON.stringify(summary, null, 2));

console.log(`SDK 是否就绪（window.AMap）：${mapReady}`);
console.log(`加载 SDK 脚本的请求：${JSON.stringify(scriptCalls)}`);
console.log(`页面上的地图提示：${mapFailureLine}`);
console.log(`控制台与高德相关的报错：${JSON.stringify(summary.consoleErrors, null, 2)}`);
console.log(`请求失败：${JSON.stringify(requestFailures)}`);
console.log(`代理请求（经过本站 /_AMapService 的次数）：${proxyResponses.length}`);
console.log(`被拦截的付费/改状态 POST（应为 0）：${JSON.stringify(blockedPosts)}`);
