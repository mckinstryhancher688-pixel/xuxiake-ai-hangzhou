import assert from "node:assert/strict";
import { analyzeVerifiedChains, describeVerifiedChainFailure } from "../src/lib/verified-chain.ts";

// 全部为人工夹具；验证选路与失败归因，不构成真实高德路线验收。
let externalCalls = 0;
globalThis.fetch = async () => {
  externalCalls += 1;
  throw new Error("组合分析离线回归禁止外部请求");
};

const pool = (ids) => ids.map((flyaiId) => ({ match: { flyaiId } }));
function leg(minutes) {
  return {
    fromName: "fixture-from", toName: "fixture-to",
    from: { lng: 120, lat: 30 }, to: { lng: 120.01, lat: 30.01 },
    distanceMeters: 100, durationMinutes: minutes, durationSeconds: minutes * 60,
    stepCount: 1, firstInstruction: null, fromCache: true, polyline: [],
    // 故意与路段时长不同，确保求解不用接口耗时来判定预算。
    durationMs: 1,
  };
}
function fullLegs(ids, minutes) {
  const legs = new Map();
  for (const to of ids) legs.set(`__start__->${to}`, leg(minutes));
  for (const from of ids) {
    for (const to of ids) if (from !== to) legs.set(`${from}->${to}`, leg(minutes));
  }
  return legs;
}
function oneChain(minutes) {
  const legs = new Map(["a", "b", "c"].map((id) => [`__start__->${id}`, leg(minutes)]));
  legs.set("a->b", leg(minutes));
  legs.set("b->c", leg(minutes));
  return legs;
}
const chosenIds = (analysis) => analysis.best?.items.map((item) => item.match.flyaiId) ?? null;
let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

check("只有起点腿且站间全缺段：不误称全部超过240分钟", () => {
  const legs = new Map(["a", "b", "c"].map((id) => [`__start__->${id}`, leg(10)]));
  const result = analyzeVerifiedChains(pool(["a", "b", "c"]), legs);
  assert.deepEqual(result, { best: null, completeCount: 0, missingLegCount: 6, minCompleteMinutes: null });
  const message = describeVerifiedChainFailure(result, 3);
  assert.match(message, /6 种/);
  assert.match(message, /缺少至少一段/);
  assert.doesNotMatch(message, /均超过|都超过|最短也需要/);
});

check("所有组合有完整实测段但确实超时：给出最短总时长与模拟项", () => {
  const result = analyzeVerifiedChains(pool(["a", "b", "c"]), fullLegs(["a", "b", "c"], 100));
  assert.equal(result.best, null);
  assert.equal(result.completeCount, 6);
  assert.equal(result.missingLegCount, 0);
  assert.equal(result.minCompleteMinutes, 410); // 3 * 100 路段 + 3 * 30 停留 + 20余量。
  const message = describeVerifiedChainFailure(result, 3);
  assert.match(message, /6 种具备完整实测路段/);
  assert.match(message, /最短也需要 410 分钟/);
  assert.match(message, /模拟停留 30 分钟\/站与 20 分钟余量/);
  assert.doesNotMatch(message, /缺少可用的实测/);
});

check("完整超时与缺段混合：分别计数，不断言缺段组合也超时", () => {
  const result = analyzeVerifiedChains(pool(["a", "b", "c"]), oneChain(100));
  assert.deepEqual(result, { best: null, completeCount: 1, missingLegCount: 5, minCompleteMinutes: 410 });
  const message = describeVerifiedChainFailure(result, 3);
  assert.match(message, /1 种具备完整实测路段/);
  assert.match(message, /另有 5 种组合缺少可用的实测有向路段，尚无法判断是否满足预算/);
});

check("只存在一条可行有向链：照常返回该链及已有实测段", () => {
  const legs = oneChain(10);
  const result = analyzeVerifiedChains(pool(["a", "b", "c"]), legs);
  assert.deepEqual(chosenIds(result), ["a", "b", "c"]);
  assert.equal(result.best.totalMinutes, 140);
  assert.equal(result.best.legs[1], legs.get("a->b"));
  assert.equal(result.completeCount, 1);
  assert.equal(result.missingLegCount, 5);
});

check("反向实测段不替代缺少的正向段", () => {
  const legs = oneChain(10);
  legs.delete("a->b");
  legs.set("b->a", leg(10));
  const result = analyzeVerifiedChains(pool(["a", "b", "c"]), legs);
  assert.equal(result.best, null);
  assert.equal(result.completeCount, 0);
  assert.equal(result.missingLegCount, 6);
});

check("成功排序保持4站优先，即使3站总耗时更短", () => {
  const ids = ["a", "b", "c", "d"];
  const legs = fullLegs(ids, 100);
  for (const key of ["__start__->a", "a->b", "b->c", "c->d"]) legs.set(key, leg(5));
  const result = analyzeVerifiedChains(pool(ids), legs);
  assert.deepEqual(chosenIds(result), ids);
  assert.equal(result.best.totalMinutes, 160);
  assert.equal(result.minCompleteMinutes, 125);
  assert.equal(result.completeCount, 48); // P(4,4) + P(4,3)。
  assert.equal(result.missingLegCount, 0);
});

check("同站数比较真实路段总耗时，选择最短有序组合", () => {
  const ids = ["a", "b", "c", "d"];
  const legs = fullLegs(ids, 20);
  for (const key of ["__start__->d", "d->c", "c->b", "b->a"]) legs.set(key, leg(5));
  const result = analyzeVerifiedChains(pool(ids), legs);
  assert.deepEqual(chosenIds(result), ["d", "c", "b", "a"]);
  assert.equal(result.best.totalMinutes, 160);
});

check("完全同分时维持原枚举顺序，不反转或随机重排", () => {
  const ids = ["a", "b", "c", "d"];
  const result = analyzeVerifiedChains(pool(ids), fullLegs(ids, 5));
  assert.deepEqual(chosenIds(result), ids);
  assert.equal(result.best.totalMinutes, 160);
});

check("240分钟恰好可行，241分钟仍拒绝，不放宽预算", () => {
  const legs = oneChain(43);
  legs.set("b->c", leg(44));
  assert.equal(analyzeVerifiedChains(pool(["a", "b", "c"]), legs).best.totalMinutes, 240);
  legs.set("b->c", leg(45));
  const result = analyzeVerifiedChains(pool(["a", "b", "c"]), legs);
  assert.equal(result.best, null);
  assert.equal(result.minCompleteMinutes, 241);
});

check("不足3站仍不成线，不把1至2站当作初始核验成功", () => {
  const result = analyzeVerifiedChains(pool(["a", "b"]), fullLegs(["a", "b"], 1));
  assert.deepEqual(result, { best: null, completeCount: 0, missingLegCount: 0, minCompleteMinutes: null });
});

check("分析不修改候选、路段内容或Map", () => {
  const items = pool(["a", "b", "c"]);
  const legs = fullLegs(["a", "b", "c"], 10);
  const before = structuredClone({ items, entries: [...legs] });
  analyzeVerifiedChains(items, legs);
  assert.deepEqual({ items, entries: [...legs] }, before);
});

assert.equal(externalCalls, 0);
console.log(`\n${passed}/${passed} 单人组合与无解归因回归通过（人工夹具，零真实 API 调用）`);
