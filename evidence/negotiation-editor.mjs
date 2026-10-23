import assert from "node:assert/strict";
import { conditionsFromDraft, costApprovalKey, draftFromConditions, savedConditionsKey } from "../src/lib/negotiation/editor.ts";

// 回归实际故障：刷新后仅编辑软偏好，不得清除未编辑的硬底线。零网络请求。
const saved = {
  role: "B",
  hard: { maxWalkMeters: 3000, latestEndMinutes: 1020, mustVisit: ["qinghe"], neverAccept: ["tower"] },
  soft: { street: "prefer", park: "follow", square: "ok", lake: "avoid" },
  bias: "walk_less",
};
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

check("刷新回填完整硬条件与全部已表达软偏好", () => {
  const expected = { hard: saved.hard, soft: saved.soft, bias: saved.bias };
  assert.deepEqual(conditionsFromDraft(draftFromConditions(saved)), expected);
});

check("只改整体倾向仍保留3000米、必须去、绝不接受及结束时刻", () => {
  const draft = { ...draftFromConditions(saved), bias: "see_more" };
  const result = conditionsFromDraft(draft);
  assert.deepEqual(result.hard, saved.hard);
  assert.deepEqual(result.soft, saved.soft);
  assert.equal(result.bias, "see_more");
});

check("必须去主动降为特别想去时只改变该站，不删除其它底线", () => {
  const draft = draftFromConditions(saved);
  draft.choices.qinghe = "prefer";
  const result = conditionsFromDraft(draft);
  assert.deepEqual(result.hard.mustVisit, []);
  assert.deepEqual(result.hard.neverAccept, ["tower"]);
  assert.equal(result.hard.maxWalkMeters, 3000);
  assert.equal(result.hard.latestEndMinutes, 1020);
  assert.equal(result.soft.qinghe, "prefer");
  assert.equal(result.soft.street, "prefer");
});

check("明确选择可以去仍是已表达评价，不与未填写混淆", () => {
  const draft = draftFromConditions(null);
  assert.deepEqual(conditionsFromDraft(draft).soft, {});
  draft.choices.newStop = "ok";
  assert.deepEqual(conditionsFromDraft(draft).soft, { newStop: "ok" });
});

check("草稿不会修改服务器快照或共用偏好对象", () => {
  const before = structuredClone(saved);
  const draft = draftFromConditions(saved);
  draft.choices.street = "never";
  assert.deepEqual(saved, before);
});

check("条件key不因无关对象顺序变动，实际硬底线变化会被发现", () => {
  const reordered = { ...saved, soft: Object.fromEntries(Object.entries(saved.soft).reverse()) };
  assert.equal(savedConditionsKey(reordered), savedConditionsKey(saved));
  assert.notEqual(savedConditionsKey({ ...saved, hard: { ...saved.hard, maxWalkMeters: 2000 } }), savedConditionsKey(saved));
});

check("旧报价绑定版本和双方条件，失败未升版的底线修改也会使其失效", () => {
  const a = { ...saved, role: "A" };
  const conditions = { A: a, B: saved };
  const quote = costApprovalKey("plan-1", "B", 2, conditions);
  assert.notEqual(quote, costApprovalKey("plan-1", "B", 3, conditions));
  assert.notEqual(quote, costApprovalKey("plan-1", "A", 2, conditions));
  assert.notEqual(quote, costApprovalKey("plan-2", "B", 2, conditions));
  assert.notEqual(quote, costApprovalKey("plan-1", "B", 2, {
    ...conditions, A: { ...a, hard: { ...a.hard, maxWalkMeters: 2000 } },
  }));
});

console.log(`\n${passed}/${passed} 编辑条件回归通过（零真实 API 调用）`);
