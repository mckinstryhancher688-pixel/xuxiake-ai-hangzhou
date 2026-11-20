/**
 * 飞猪实景图文字段验收：mainPic 与 freePoiStatus 是否真的经过服务端解析进了 DiscoveredPoi。
 *
 * 零付费：只打 /api/discover（该路径只 spawn 飞猪 CLI，不含高德与百炼调用）。
 * 跑法：先 npm run build && npm run start，再 node evidence/flyai-photo-accept.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const CITY = "杭州";
const CATEGORY = "文创街区";

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
};

const before = await (await fetch(`${BASE}/api/discover`)).json();
check("0 服务端已配置飞猪 key 与 CLI", before.keyPresent === true && before.cliAvailable === true, {
  keyMask: before.keyMask,
  cli: before.cliEntry,
});

const response = await fetch(`${BASE}/api/discover`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cityName: CITY, categories: [CATEGORY] }),
});
const body = await response.json();
const batch = body?.batch ?? null;
const result = batch?.results?.[0] ?? null;
const items = result?.items ?? [];

check("1 /api/discover 返回真实批次（origin=flyai-live）", batch?.origin === "flyai-live" && batch?.ok === true, {
  origin: batch?.origin,
  ok: batch?.ok,
  error: batch?.error ?? result?.error ?? null,
});
check("2 这一批有候选", items.length > 0, { count: items.length });

const withPic = items.filter((item) => typeof item.mainPic === "string" && /^https?:\/\//.test(item.mainPic));
const withFree = items.filter((item) => item.freePoiStatus === "FREE");
const picNullOrString = items.every((item) => item.mainPic === null || typeof item.mainPic === "string");
const freeNullOrString = items.every((item) => item.freePoiStatus === null || typeof item.freePoiStatus === "string");

check("3 mainPic 已解析成字段（缺失时为 null，不是 undefined）", picNullOrString && "mainPic" in (items[0] ?? {}), {
  有图: withPic.length,
  总数: items.length,
});
check("4 mainPic 只放行 http(s)，没有 javascript: 之类的值", withPic.length === items.filter((i) => i.mainPic).length);
check("5 freePoiStatus 已解析成字段", freeNullOrString && "freePoiStatus" in (items[0] ?? {}), {
  免费: withFree.length,
  总数: items.length,
});
check("6 图片与免费标注都没进 missingFields（缺了不算数据缺失）", items.every((item) => !item.missingFields.includes("mainPic") && !item.missingFields.includes("freePoiStatus")));

const after = await (await fetch(`${BASE}/api/discover`)).json();
check("7 本次只新增 1 次飞猪 CLI 调用，未触碰高德/百炼", after.hourlyCallsUsed === before.hourlyCallsUsed + 1, {
  before: before.hourlyCallsUsed,
  after: after.hourlyCallsUsed,
});

const sample = items.slice(0, 5).map((item) => ({
  name: item.name,
  mainPic: item.mainPic,
  freePoiStatus: item.freePoiStatus,
  missingFields: item.missingFields,
}));
console.log("\n=== 样本（前 5 条）===");
for (const row of sample) {
  console.log(`${row.name} | free=${row.freePoiStatus} | pic=${row.mainPic ? row.mainPic.slice(0, 72) + "…" : "null"}`);
}

const summary = {
  checkedAt: new Date().toISOString(),
  baseUrl: BASE,
  paid: false,
  paidNotice: "只调用 /api/discover（飞猪 CLI）；高德与百炼调用为 0，本次不产生任何计费请求。",
  cityName: CITY,
  category: CATEGORY,
  itemCount: items.length,
  withMainPic: withPic.length,
  withFreeStatus: withFree.length,
  freeStatusValues: [...new Set(items.map((item) => item.freePoiStatus))],
  flyaiHourlyCalls: { before: before.hourlyCallsUsed, after: after.hourlyCallsUsed },
  proof: result?.proof ?? null,
  sample,
  total: results.length,
  passed: results.length - results.filter((r) => !r.pass).length,
  checks: results,
};
fs.writeFileSync(path.join(EVIDENCE, "flyai-photo-accept.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} 通过`);
for (const item of results.filter((r) => !r.pass)) console.log(`未通过：${item.name}`);
process.exit(results.some((r) => !r.pass) ? 1 : 0);
