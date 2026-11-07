import assert from "node:assert/strict";
import {
  auditStopSources,
  flyaiIdFromSourceOf,
  sourceEvidenceOf,
} from "../src/lib/source-evidence.ts";
import { parsePoiPayload } from "../src/lib/server/discover.ts";
import { solveJoint } from "../src/lib/negotiation/solve.ts";
import { emptyConditions } from "../src/lib/negotiation/types.ts";
import { formatHangzhouDateTime, formatHangzhouShort } from "../src/lib/hangzhou-time.ts";
import { makeCompleteFacts } from "./negotiation-fixture.ts";

// 飞猪优化① B1/A 的零付费夹具回归：解析、来源校验、证据判定、协商透传。
// 所有数字与链接都是夹具，不代表飞猪/高德真实返回；无网络、无子进程、无文件写入。
let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const PROOF = {
  invokedAt: "2026-11-07T06:30:00.000Z",
  durationMs: 1200,
  exitCode: 0,
  command: "flyai search-poi（夹具）",
  cliEntry: "node_modules/@fly-ai/flyai-cli/dist/flyai-bundle.cjs",
  keySource: "env:FLYAI_API_KEY",
  stdoutBytes: 100,
  cacheHit: false,
};

function payload(items) {
  return JSON.stringify({ status: 0, data: { itemList: items } });
}

/* ── flyaiIdFromSourceOf ─────────────────────────────────────────── */
check("字段完整 → id 来自飞猪", () => assert.equal(flyaiIdFromSourceOf({ missingFields: [] }), true));
check("缺 id → 占位标识不算来源可校验", () => assert.equal(flyaiIdFromSourceOf({ missingFields: ["id", "address"] }), false));
check("只缺地址不影响 id 来源判定", () => assert.equal(flyaiIdFromSourceOf({ missingFields: ["address"] }), true));

/* ── parsePoiPayload：采集时间与 id 来源 ─────────────────────────── */
check("解析真实形状：每项带上本次查询时间", () => {
  const result = parsePoiPayload("文创街区", payload([
    { id: "poi-1", name: "集贤亭", address: "杭州市上城区", jumpUrl: "https://example.fliggy.com/poi-1", latitude: "30.256", longitude: "120.154" },
  ]), PROOF);
  assert.equal(result.error, null);
  assert.equal(result.items[0].collectedAt, PROOF.invokedAt);
  assert.equal(flyaiIdFromSourceOf(result.items[0]), true);
  assert.equal(result.proof.rawItemCount, 1);
});
check("飞猪缺 id：补占位标识、标缺失、来源校验不通过，但采集时间仍在", () => {
  const result = parsePoiPayload("文创街区", payload([{ name: "无 id 地点" }]), PROOF);
  const item = result.items[0];
  assert.ok(item.id.startsWith("flyai-"));
  assert.ok(item.missingFields.includes("id"));
  assert.equal(flyaiIdFromSourceOf(item), false);
  assert.equal(item.collectedAt, PROOF.invokedAt);
});
check("javascript: 链接被拒（既有安全回归）", () => {
  const result = parsePoiPayload("文创街区", payload([
    { id: "poi-2", name: "恶意链接", jumpUrl: "javascript:alert(1)" },
  ]), PROOF);
  assert.equal(result.items[0].jumpUrl, null);
  assert.ok(result.items[0].missingFields.includes("jumpUrl"));
});
check("缓存复用不改原采集时间（凭证 cacheHit 翻转，items 原样）", () => {
  const first = parsePoiPayload("文创街区", payload([{ id: "poi-3", name: "缓存项" }]), PROOF);
  const reused = { ...first, proof: { ...first.proof, cacheHit: true } };
  assert.equal(reused.items[0].collectedAt, PROOF.invokedAt);
  assert.equal(reused.proof.cacheHit, true);
});

/* ── auditStopSources：行程对回本次候选集合 ──────────────────────── */
function makeItinerary(stops) {
  const start = { name: "湖滨公园（夹具）", amapId: "amap-start", address: null, position: { lat: 30.255, lng: 120.155 }, reason: "夹具" };
  const legs = stops.map((stop, i) => ({
    fromName: i === 0 ? start.name : stops[i - 1].name, toName: stop.name,
    from: start.position, to: stop.position, distanceMeters: 400, durationMinutes: 5, durationSeconds: 300,
    stepCount: 0, firstInstruction: null, polyline: [], fromCache: false,
  }));
  return {
    start, stops, legs, totalWalkMeters: 400 * stops.length, totalWalkMinutes: 5 * stops.length,
    totalStayMinutes: 30 * stops.length, bufferMinutes: 20, totalMinutes: 35 * stops.length + 20,
    budgetMinutes: 240, feasible: true, assumedStartAt: PROOF.invokedAt,
  };
}
function stop(id, name, jumpUrl, extra = {}) {
  return {
    name, flyaiId: id, amapId: `amap-${id}`, address: null, position: { lat: 30.256, lng: 120.154 },
    matchStatus: "matched", stayMinutes: 30, staySource: "simulated", openingStatus: "no-conflict",
    openingNote: "夹具", jumpUrl, flyaiDescription: null, flyaiIdFromSource: true, flyaiCollectedAt: PROOF.invokedAt,
    ...extra,
  };
}
const MATCHES = [
  { flyaiId: "poi-1", jumpUrl: "https://example.fliggy.com/poi-1" },
  { flyaiId: "poi-2", jumpUrl: null },
];

check("id 与链接都对得上 → 不改行程、不标旗", () => {
  const itinerary = makeItinerary([stop("poi-1", "集贤亭", MATCHES[0].jumpUrl), stop("poi-2", "圣塘", null)]);
  const audit = auditStopSources(itinerary, MATCHES);
  assert.deepEqual(audit.flagged, []);
  assert.strictEqual(audit.itinerary, itinerary);
});
check("编造的 flyaiId 不在候选集合 → 标未校验并留痕", () => {
  const itinerary = makeItinerary([stop("fabricated", "假地点", "https://example.fliggy.com/poi-1")]);
  const audit = auditStopSources(itinerary, MATCHES);
  assert.deepEqual(audit.flagged, ["假地点"]);
  assert.equal(audit.itinerary.stops[0].flyaiIdFromSource, false);
});
check("链接被篡改（与候选记录不一致）→ 标未校验", () => {
  const itinerary = makeItinerary([stop("poi-1", "集贤亭", "https://evil.example.com/phish")]);
  const audit = auditStopSources(itinerary, MATCHES);
  assert.deepEqual(audit.flagged, ["集贤亭"]);
  assert.equal(audit.itinerary.stops[0].flyaiIdFromSource, false);
});
check("候选与站点都无链接（null===null）→ 视为一致", () => {
  const itinerary = makeItinerary([stop("poi-2", "圣塘", null)]);
  assert.deepEqual(auditStopSources(itinerary, MATCHES).flagged, []);
});
check("只标对不上的站，不误伤同行其余站", () => {
  const itinerary = makeItinerary([stop("poi-1", "集贤亭", MATCHES[0].jumpUrl), stop("ghost", "幽灵站", null)]);
  const audit = auditStopSources(itinerary, MATCHES);
  assert.deepEqual(audit.flagged, ["幽灵站"]);
  assert.equal(audit.itinerary.stops[0].flyaiIdFromSource, true);
  assert.equal(audit.itinerary.stops[1].flyaiIdFromSource, false);
});

/* ── sourceEvidenceOf：✓ 只在通过时点亮 ──────────────────────────── */
check("校验通过 → checked，带采集时间", () => {
  const evidence = sourceEvidenceOf({ flyaiIdFromSource: true, flyaiCollectedAt: PROOF.invokedAt });
  assert.equal(evidence.state, "checked");
  assert.equal(evidence.reason, null);
  assert.equal(evidence.collectedAt, PROOF.invokedAt);
});
check("校验未通过 → unchecked，原因明确", () => {
  const evidence = sourceEvidenceOf({ flyaiIdFromSource: false, flyaiCollectedAt: null });
  assert.equal(evidence.state, "unchecked");
  assert.equal(evidence.reason, "id 未通过来源校验");
});
check("早期记录无校验字段 → unchecked，不冒充已校验", () => {
  const evidence = sourceEvidenceOf({});
  assert.equal(evidence.state, "unchecked");
  assert.equal(evidence.reason, "早期记录未留存来源校验");
  assert.equal(evidence.collectedAt, null);
});
check("通过但无采集时间 → checked 且时间为 null（界面写未记录）", () => {
  const evidence = sourceEvidenceOf({ flyaiIdFromSource: true });
  assert.equal(evidence.state, "checked");
  assert.equal(evidence.collectedAt, null);
});

/* ── 协商层透传：事实集字段一路带到正式行程站点 ──────────────────── */
check("双人重解后的站点保留来源时间与校验标记", () => {
  const facts = makeCompleteFacts();
  facts.pool = facts.pool.map((item, i) => ({
    ...item, flyaiCollectedAt: PROOF.invokedAt, flyaiIdFromSource: i !== 0,
  }));
  const solve = solveJoint(facts, emptyConditions("A"), emptyConditions("B"), new Date("2026-11-07T13:00:00"));
  assert.ok(solve.best);
  for (const stop of solve.best.stops) {
    assert.equal(stop.flyaiCollectedAt, PROOF.invokedAt);
    assert.equal(typeof stop.flyaiIdFromSource, "boolean");
  }
});

/* ── 快照兼容：新字段可序列化，旧记录不崩 ────────────────────────── */
check("带证据字段的站点 JSON 往返不丢字段", () => {
  const original = stop("poi-1", "集贤亭", MATCHES[0].jumpUrl);
  const restored = JSON.parse(JSON.stringify(original));
  assert.equal(restored.flyaiCollectedAt, PROOF.invokedAt);
  assert.equal(sourceEvidenceOf(restored).state, "checked");
});
check("旧快照站点（无新字段）判为未校验而非报错", () => {
  const legacy = { name: "老站", flyaiId: "old", jumpUrl: null };
  assert.equal(sourceEvidenceOf(legacy).state, "unchecked");
});

/* ── 紧凑时间：杭州时区、不含冗长时区后缀 ────────────────────────── */
check("证据条时间按杭州时区且比完整格式紧凑", () => {
  const short = formatHangzhouShort("2026-11-07T06:30:00.000Z");
  assert.ok(short.includes("14:30"), short);
  assert.ok(short.includes("07"), short);
  assert.ok(!short.includes("Asia/Shanghai"), short);
  assert.ok(short.length < formatHangzhouDateTime("2026-11-07T06:30:00.000Z").length);
});

console.log(`\n${passed}/${passed} 来源证据零付费夹具回归通过（纯夹具，零真实 API 调用）`);