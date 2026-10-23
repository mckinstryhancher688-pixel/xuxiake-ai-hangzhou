import assert from "node:assert/strict";
import {
  createGeometryCache, geometryMode, geometryRequest, loadGeometry, pendingGeometry,
} from "../src/lib/map/geometry-state.ts";

// 全部为模拟坐标/折线与注入 loader；不加载 React 或 provider，不发网络请求。
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const scope = { planId: "fixture-plan", token: "fixture-secret-token", officialRevision: 2 };
const from = { lat: 30.25, lng: 120.15 };
const to = { lat: 30.26, lng: 120.16 };
const itinerary = { legs: [{ from, to, toName: "夹具终点", polyline: [] }] };
const pending = pendingGeometry(itinerary);
const polyline = [from, to]; // 明确为夹具，不是高德道路几何。

await check("联合凭据缺失/无效时禁止生成单人补测请求", () => {
  for (const invalid of [null, {}, { ...scope, token: "" }, { ...scope, officialRevision: 0 }]) {
    const mode = geometryMode(invalid, true);
    assert.equal(mode.kind, "blocked");
    assert.equal(geometryRequest(mode, pending), null);
  }
  assert.equal(geometryRequest({ kind: "joint", plan: null, key: "invalid" }, pending), null);
});
await check("正式请求把令牌放请求头，正文只含planId/revision/legs", () => {
  const request = geometryRequest(geometryMode(scope, true), pending);
  assert.equal(request.headers["x-plan-role-token"], scope.token);
  assert.equal(request.body.includes(scope.token), false);
  assert.deepEqual(Object.keys(JSON.parse(request.body)).sort(), ["legs", "officialRevision", "planId"]);
  assert.equal(JSON.parse(request.body).officialRevision, 2);
});
await check("单人请求保留原坐标接口，不夹带联合身份", () => {
  const request = geometryRequest(geometryMode(scope, false), pending);
  assert.equal(request.headers["x-plan-role-token"], undefined);
  assert.deepEqual(JSON.parse(request.body), { legs: [{ from, to }] });
});
await check("模式/计划/正式版本/角色令牌分别隔离缓存", () => {
  const keys = [
    geometryMode(scope, false).key, geometryMode(scope, true).key,
    geometryMode({ ...scope, planId: "fixture-other" }, true).key,
    geometryMode({ ...scope, officialRevision: 3 }, true).key,
    geometryMode({ ...scope, token: "fixture-other-token" }, true).key,
  ];
  assert.equal(new Set(keys).size, keys.length);
});
await check("同版轮询的新对象得到稳定pending，已有折线不会重复请求", () => {
  assert.equal(JSON.stringify(pendingGeometry(structuredClone(itinerary))), JSON.stringify(pending));
  assert.deepEqual(pendingGeometry({ legs: [{ ...itinerary.legs[0], polyline }] }), []);
});
await check("StrictMode重新订阅在途Promise，不提前标完成，也不丢最终折线", async () => {
  const cache = createGeometryCache("fixture-scope");
  let release;
  let calls = 0;
  const loader = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  const first = loadGeometry(cache, pending, loader);
  const second = loadGeometry(cache, structuredClone(pending), loader);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(cache.completed.size, 0);
  assert.equal(cache.tasks.size, 1);
  release({ byLeg: { [pending[0].key]: polyline }, note: "夹具只读结果" });
  await Promise.all([first, second]);
  assert.deepEqual(cache.byLeg[pending[0].key], polyline);
  assert.equal(cache.completed.size, 1);
  assert.equal(cache.tasks.size, 0);
  await loadGeometry(cache, structuredClone(pending), loader);
  assert.equal(calls, 1);
});
await check("旧作用域迟到只填自己的缓存，不能覆盖新版本折线", async () => {
  const old = createGeometryCache("old");
  const current = createGeometryCache("new");
  let release;
  const wait = loadGeometry(old, pending, () => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const currentLine = [{ lat: 30.251, lng: 120.151 }, to];
  await loadGeometry(current, pending, async () => ({ byLeg: { [pending[0].key]: currentLine }, note: "新版本" }));
  release({ byLeg: { [pending[0].key]: polyline }, note: "旧版本迟到" });
  await wait;
  assert.deepEqual(current.byLeg[pending[0].key], currentLine);
  assert.equal(current.note, "新版本");
});
await check("失败结果保留缺几何状态，不因轮询自动重试或走另一loader", async () => {
  const cache = createGeometryCache();
  let calls = 0;
  await loadGeometry(cache, pending, async () => { calls++; throw new Error("夹具失败"); });
  await loadGeometry(cache, pending, async () => { calls++; return { byLeg: {}, note: "不应执行" }; });
  assert.equal(calls, 1);
  assert.deepEqual(cache.byLeg, {});
  assert.match(cache.note, /失败/);
});

console.log(`${passed}/${passed} 通过（纯作用域/在途缓存/请求契约，零真实调用）`);
