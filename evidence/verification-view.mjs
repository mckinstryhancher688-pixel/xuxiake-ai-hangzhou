import assert from "node:assert/strict";
import { DEFAULT_DISCOVER_CATEGORIES, sameCategories } from "../src/lib/discovery.ts";
import { DEFAULT_VERIFY_CATEGORIES } from "../src/lib/verification.ts";
import {
  beginVerification, canApplyVerification, categoriesForReport, createVerificationScope, reportForCity,
} from "../src/lib/verification-view.ts";

/** 仅核验浏览器状态的纯投影与作用域，不导入 hook/provider、不发网络请求。 */
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }
// 只列出这些纯函数读取的报告字段，不冒充任何高德实测报告。
const previous = { cityName: "杭州", categories: ["自然风光"], itinerary: { stops: [] } };

check("保留 API 旧的双类别 fallback，UI 默认单文创互不混淆", () => {
  assert.deepEqual(DEFAULT_DISCOVER_CATEGORIES, ["文创街区"]);
  assert.deepEqual(DEFAULT_VERIFY_CATEGORIES, ["自然风光", "文创街区"]);
});
check("同类别比较不依赖勾选顺序，双类不能冒充单类", () => {
  assert.equal(sameCategories(["自然风光", "文创街区"], ["文创街区", "自然风光"]), true);
  assert.equal(sameCategories(["自然风光", "文创街区"], ["文创街区"]), false);
  assert.equal(sameCategories(["城市观光"], ["文创街区"]), false);
});
check("新类别请求在途或失败时，旧报告仍使用报告自己的真实类别", () => {
  const requested = ["城市观光"];
  assert.deepEqual(categoriesForReport(previous, requested), ["自然风光"]);
  assert.deepEqual(requested, ["城市观光"]);
  assert.deepEqual(categoriesForReport(null, requested), ["城市观光"]);
});
check("旧快照 usedCategories 即使已被污染，也以 report.categories 为准", () => {
  const snapshot = { cityName: "杭州", report: previous, usedCategories: ["城市观光"] };
  const shown = reportForCity("杭州", null, snapshot);
  assert.equal(shown, previous);
  assert.deepEqual(categoriesForReport(shown, ["文创街区"]), ["自然风光"]);
});
check("空类别报告不静默借用当前勾选类别冒充来源", () => {
  assert.deepEqual(categoriesForReport({ ...previous, categories: [] }, ["城市观光"]), []);
});
check("切换城市不显示前城 override，也不接受内外城市不一致的快照", () => {
  assert.equal(reportForCity("上海", previous, null), null);
  assert.equal(reportForCity("上海", null, { cityName: "上海", report: previous, usedCategories: [] }), null);
  assert.equal(reportForCity("杭州", null, { cityName: "上海", report: previous, usedCategories: [] }), null);
});
check("同城的新失败报告仍是本轮真实报告，不偷偷恢复上一份可行路线", () => {
  const failedReport = { cityName: "杭州", categories: ["城市观光"], itinerary: null, ok: false };
  const snapshot = { cityName: "杭州", report: previous, usedCategories: ["自然风光"] };
  assert.equal(reportForCity("杭州", failedReport, snapshot), failedReport);
  assert.deepEqual(categoriesForReport(failedReport, ["文创街区"]), ["城市观光"]);
});
check("新请求开始后，旧成功/失败/计数回包均失去写回资格", () => {
  const scope = createVerificationScope("杭州");
  const first = beginVerification(scope);
  assert.equal(canApplyVerification(scope, first), true);
  const second = beginVerification(scope);
  assert.equal(canApplyVerification(scope, first), false);
  assert.equal(canApplyVerification(scope, second), true);
});
check("离开城市后关闭作用域，再回同城也不能复活旧请求", () => {
  const oldScope = createVerificationScope("杭州");
  const oldRequest = beginVerification(oldScope);
  oldScope.closed = true;
  assert.equal(beginVerification(oldScope), null);
  const newScope = createVerificationScope("杭州");
  const newRequest = beginVerification(newScope);
  assert.equal(newRequest.sequence, oldRequest.sequence);
  assert.equal(canApplyVerification(newScope, oldRequest), false);
  assert.equal(canApplyVerification(newScope, newRequest), true);
});
check("不同城市同一请求序号不能互相写回", () => {
  const hangzhou = createVerificationScope("杭州");
  const shanghai = createVerificationScope("上海");
  const oldRequest = beginVerification(hangzhou);
  const currentRequest = beginVerification(shanghai);
  assert.equal(currentRequest.sequence, oldRequest.sequence);
  assert.equal(canApplyVerification(shanghai, oldRequest), false);
  assert.equal(canApplyVerification(shanghai, currentRequest), true);
});

console.log(`${passed}/${passed} 通过（纯报告投影与请求作用域，零真实调用）`);
