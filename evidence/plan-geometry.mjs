import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeCompleteFacts } from "./negotiation-fixture.ts";
import { emptyConditions } from "../src/lib/negotiation/types.ts";

/**
 * 联合正式路线几何只读验收。夹具折线由测试人为构造，仅证明原样复用，不能当成真实道路证据。
 * 假 key 让误入高德路径时仍会触发 fetch 桩，避免空 key 掩盖付费入口回归。
 * 跑法：node --import ./evidence/register-alias.mjs evidence/plan-geometry.mjs
 */
process.env.PLAN_SNAPSHOT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xuxiake-geometry-")), "snapshot.json");
process.env.AMAP_WEB_KEY = "fake-for-zero-cost-geometry-test";
const outbound = [];
globalThis.fetch = async (input) => {
  outbound.push(String(input));
  throw new Error("几何验收禁止外部调用。");
};
const store = await import("../src/lib/server/plan-store.ts");
const factsStore = await import("../src/lib/server/facts.ts");
const amap = await import("../src/lib/server/amap.ts");
const { POST } = await import("../src/app/api/route-geometry/route.ts");
const baseline = amap.amapCounters().walkingCalls;
const results = [];
function check(name, pass) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
}
let serial = 0;
async function prepared() {
  const facts = makeCompleteFacts();
  facts.factsId = `geometry-test-${++serial}`;
  facts.measuredAt = new Date().toISOString();
  for (const entry of Object.values(facts.legs)) {
    entry.measuredAt = facts.measuredAt;
    entry.leg.polyline = [entry.leg.from, entry.leg.to]; // 仅测试用合成折线。
  }
  factsStore.putFactSet(facts);
  const created = store.createPlanRecord({ facts, conditionsA: emptyConditions("A"), now: new Date() });
  for (const [role, expectedRevision] of [["A", null], ["B", 1]]) {
    const result = await store.runPlanMutation(created.planId, {
      kind: "conditions", role, conditions: emptyConditions(role), expectedRevision,
      attemptId: `geometry-${serial}-${role}`, confirmCost: false,
    });
    if (result.code !== "ok") throw new Error(`夹具建版失败：${result.code}`);
  }
  return { ...created, facts };
}
async function confirmed(plan) {
  const snap = store.planSnapshot(plan.planId, "A");
  for (const role of ["A", "B"]) {
    const result = await store.runPlanMutation(plan.planId, {
      kind: "confirm", role, revision: snap.headRevision, contentHash: snap.head.contentHash,
    });
    if (result.code !== "ok") throw new Error(`夹具确认失败：${result.code}`);
  }
  return store.planExecutionJourney(plan.planId);
}
async function call(body, token, raw = false) {
  const response = await POST(new Request("http://localhost/api/route-geometry", {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-plan-role-token": token } : {}) },
    body: raw ? body : JSON.stringify(body),
  }));
  return { status: response.status, data: await response.json() };
}
function pair(leg) { return { from: leg.from, to: leg.to }; }
function refused(result, status) {
  return result.status === status && result.data.legs.length === 0 && result.data.newCalls === 0 && !!result.data.error;
}

const plan = await prepared();
const waiting = await call({ planId: plan.planId, officialRevision: 2, legs: [] }, plan.tokens.A);
check("双方未确认不能读正式几何", refused(waiting, 409));
const journey = await confirmed(plan);
const body = { planId: plan.planId, officialRevision: journey.officialRevision, legs: journey.itinerary.legs.map(pair) };
const stored = await call(body, plan.tokens.B);
check("B 可读同版正式路线已有折线且零新增", stored.status === 200 && stored.data.newCalls === 0 && stored.data.legs.length === body.legs.length);
check("正式几何原样返回且附保存的真实距离", stored.data.legs.every((leg, i) =>
  JSON.stringify(leg.polyline) === JSON.stringify(journey.itinerary.legs[i].polyline) &&
  leg.distanceMeters === journey.itinerary.legs[i].distanceMeters && leg.fromCache && leg.error === null));
const reordered = await call({ ...body, legs: [body.legs[1], body.legs[0]] }, plan.tokens.A);
check("请求子集按请求顺序对齐下标", reordered.status === 200 && reordered.data.legs[0].index === 0 &&
  JSON.stringify(reordered.data.legs[0].polyline) === JSON.stringify(journey.itinerary.legs[1].polyline) &&
  JSON.stringify(reordered.data.legs[1].polyline) === JSON.stringify(journey.itinerary.legs[0].polyline));
journey.itinerary.legs[0].polyline = [];
const missing = await call(body, plan.tokens.A);
check("缺折线明确留空报错而不补查", missing.status === 200 && missing.data.newCalls === 0 &&
  missing.data.legs[0].polyline.length === 0 && missing.data.legs[0].error.includes("未补查高德") && !missing.data.legs[0].fromCache);
check("单段缺几何不抹掉其余已有几何", missing.data.legs.slice(1).every((leg) => leg.polyline.length >= 2));
check("错误角色凭据拒绝且不补查", refused(await call(body, "wrong-token"), 401));
check("缺失角色凭据拒绝且不补查", refused(await call(body), 401));
check("未知方案不落回单人入口", refused(await call({ ...body, planId: "unknown-geometry-plan" }, plan.tokens.A), 410));
check("旧正式版本拒绝", refused(await call({ ...body, officialRevision: 1 }, plan.tokens.A), 409));
const arbitrary = { from: { lat: 30, lng: 120 }, to: { lat: 31, lng: 121 } };
check("任意合法坐标不能借联合入口补测", refused(await call({ ...body, legs: [arbitrary] }, plan.tokens.A), 409));
check("反向坐标不能冒充正式路段", refused(await call({ ...body, legs: [{ from: body.legs[0].to, to: body.legs[0].from }] }, plan.tokens.A), 409));
check("微小偏移也不能变成新增测量", refused(await call({ ...body, legs: [{ from: { ...body.legs[0].from, lat: body.legs[0].from.lat + 0.0000001 }, to: body.legs[0].to }] }, plan.tokens.A), 409));
const extra = Object.values(plan.facts.legs).find(({ leg }) => !body.legs.some((p) => JSON.stringify(p) === JSON.stringify(pair(leg))));
check("事实池其它已测段也不能越过正式路线范围", refused(await call({ ...body, legs: [pair(extra.leg)] }, plan.tokens.A), 409));
for (const [label, change] of [
  ["null方案ID", { planId: null }], ["空方案ID", { planId: "" }], ["数字方案ID", { planId: 42 }],
  ["超长方案ID", { planId: "x".repeat(65) }], ["null版本号", { officialRevision: null }],
  ["字符串版本号", { officialRevision: "2" }], ["零版本号", { officialRevision: 0 }],
]) {
  check(`${label}仍强制只读拒绝`, refused(await call({ ...body, ...change }, plan.tokens.A), 400));
}
check("只有planId也不回退单人付费", refused(await call({ planId: plan.planId, legs: [arbitrary] }, plan.tokens.A), 400));
check("只有officialRevision也不回退单人付费", refused(await call({ officialRevision: 2, legs: [arbitrary] }, plan.tokens.A), 400));
check("非法坐标返回统一几何错误结构", refused(await call({ ...body, legs: [{ from: { lat: 99, lng: 120 }, to: arbitrary.to }] }, plan.tokens.A), 400));
check("过多请求段拒绝", refused(await call({ ...body, legs: Array(9).fill(body.legs[0]) }, plan.tokens.A), 400));
check("缺legs拒绝", refused(await call({ planId: plan.planId, officialRevision: 2 }, plan.tokens.A), 400));
check("坏JSON保持几何错误结构", refused(await call("{", null, true), 400));
check("非对象JSON拒绝", refused(await call([], null), 400));
check("超大请求体拒绝", refused(await call(`{"planId":"${"x".repeat(9000)}"}`, null, true), 413));
check("无联合字段的空单人请求仍兼容", (await call({ legs: [] })).status === 200);

const proposal = await store.runPlanMutation(plan.planId, { kind: "propose", role: "A", expectedRevision: 2, attemptId: "geometry-v3" });
check("更高未确认提案不替换旧正式版几何", proposal.code === "ok" && (await call(body, plan.tokens.A)).status === 200);
check("未确认head不能冒充正式版", refused(await call({ ...body, officialRevision: 3 }, plan.tokens.A), 409));
const noSolution = await store.runPlanMutation(plan.planId, {
  kind: "conditions", role: "B", conditions: { ...emptyConditions("B"), hard: { ...emptyConditions("B").hard, maxWalkMeters: 200 } },
  expectedRevision: 3, attemptId: "geometry-pause", confirmCost: false,
});
check("违反现行底线挂起后旧正式几何不可读", noSolution.code === "no-solution" && refused(await call(body, plan.tokens.B), 409));

const expiring = await prepared();
const live = await confirmed(expiring);
expiring.facts.measuredAt = new Date(Date.now() - 6 * 60 * 60 * 1000 - 1).toISOString();
const expired = await call({ planId: expiring.planId, officialRevision: live.officialRevision, legs: live.itinerary.legs.map(pair) }, expiring.tokens.B);
check("事实过期时即便已确认也拒绝且提示重新核验", refused(expired, 409) && expired.data.error.includes("事实层已过期"));
await store.runPlanMutation(plan.planId, { kind: "revoke", role: "A" });
check("撤销链接后读几何被拒绝", refused(await call(body, plan.tokens.B), 410));
check("全部成功和拒绝路径fetch为0（使用非空假高德key）", outbound.length === 0);
check("全部路径高德walkingCalls仍为0", baseline === 0 && amap.amapCounters().walkingCalls === 0);
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed; external fetch=${outbound.length}; walkingCalls=${amap.amapCounters().walkingCalls}`);
if (failed.length) process.exitCode = 1;
