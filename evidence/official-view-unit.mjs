import assert from "node:assert/strict";
import { executableOfficial } from "../src/lib/negotiation/official-view.ts";
import { emptyConditions } from "../src/lib/negotiation/types.ts";
import { solveJoint } from "../src/lib/negotiation/solve.ts";
import { makeCompleteFacts } from "./negotiation-fixture.ts";

// 纯夹具门禁回归：路线数字是模拟值，不代表高德真实验收；无网络与文件写入。
const solve = solveJoint(makeCompleteFacts(), emptyConditions("A"), emptyConditions("B"), new Date("2026-10-21T13:00:00"));
assert.ok(solve.best);
const official = { revision: 2, status: "jointly-confirmed", suspended: null, itinerary: solve.best };
const snapshot = {
  canExecute: { allowed: true, reason: "夹具：双方确认完成" },
  officialRevision: 2,
  official,
};
let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

check("读不到方案时不显示正式路线", () => assert.equal(executableOfficial(null, false, null), null));
check("保存条件或确认在途时隐藏旧正式路线", () => assert.equal(executableOfficial(snapshot, true, null), null));
check("状态同步失败时不把旧快照当作可执行", () => assert.equal(executableOfficial(snapshot, false, "夹具：同步失败"), null));
check("服务端未放行时不显示已挂起的官方记录", () => {
  assert.equal(executableOfficial({ ...snapshot, canExecute: { allowed: false, reason: "条件已更新" } }, false, null), null);
});
check("正式版本缺失时不能用待确认版本顶替", () => assert.equal(executableOfficial({ ...snapshot, official: null }, false, null), null));
check("明确挂起或已被取代的版本不显示", () => {
  assert.equal(executableOfficial({ ...snapshot, official: { ...official, suspended: { at: "fixture", reason: "底线变化" } } }, false, null), null);
  assert.equal(executableOfficial({ ...snapshot, official: { ...official, status: "superseded" } }, false, null), null);
});
check("正式版本编号不一致时拒绝展示", () => assert.equal(executableOfficial({ ...snapshot, officialRevision: 3 }, false, null), null));
check("有效正式版直接复用服务端起点、顺序和每段数字，不重新生成路线", () => {
  const selected = executableOfficial(snapshot, false, null);
  assert.strictEqual(selected, official);
  assert.strictEqual(selected.itinerary.start, solve.best.start);
  assert.strictEqual(selected.itinerary.stops, solve.best.stops);
  assert.strictEqual(selected.itinerary.legs, solve.best.legs);
});
check("待确认的新提案不替代仍有效的上一正式版", () => {
  const proposing = { ...snapshot, headRevision: 3, status: "awaiting-confirmation", head: { revision: 3, status: "pending-review" } };
  assert.strictEqual(executableOfficial(proposing, false, null), official);
});

console.log(`\n${passed}/${passed} 正式行程展示门禁回归通过（纯夹具，零真实 API 调用）`);
