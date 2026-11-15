/**
 * 单人「事实层免费重解」纯函数回归（亲情场景 A 方案）。
 * 纯夹具，零真实 API 调用。跑法：node --import ./evidence/register-alias.mjs evidence/solo-resolve-unit.mjs
 */
import { makeCompleteFacts, makeShortlistedFacts } from "./negotiation-fixture.ts";

const { solveSolo, canExecuteSolo } = await import("../src/lib/negotiation/solo.ts");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
};

const NOW = new Date("2026-11-15T05:00:00.000Z");
const facts = makeCompleteFacts();

/* 1. 不设上限：能排出方案，explanation 有 verdict */
const free = solveSolo(facts, { maxWalkMeters: null, mustVisit: [], neverAccept: [] }, NOW);
check("1 不设上限也能解出行程", free.ok === true && Boolean(free.solve.best), free.ok ? undefined : free.reason);
check("1b 不设上限时 withinLimit 恒为 true", free.ok && free.explanation.withinLimit === true);
check("1c verdict 如实写出总步行且不设上限", free.ok && /全天走 \d+ 米/.test(free.explanation.verdict) && free.explanation.verdict.includes("没有设走路上限"), free.ok ? free.explanation.verdict : null);

/* 2. 收紧上限：只减不增，且服务端自己判定在限内 */
const baseMeters = free.ok ? free.explanation.totalWalkMeters : 0;
const tightLimit = Math.max(200, Math.floor(baseMeters * 0.5));
const tight = solveSolo(facts, { maxWalkMeters: tightLimit, mustVisit: [], neverAccept: [] }, NOW);
check("2 收紧上限仍能解出方案", tight.ok === true && Boolean(tight.solve.best), tight.ok ? undefined : tight.reason);
check("2b 收紧后总步行不超过上限（服务端判定）", tight.ok && tight.solve.best.totalWalkMeters <= tightLimit, tight.ok ? { walk: tight.solve.best.totalWalkMeters, limit: tightLimit } : null);
check("2c 收紧后总步行比不设上限更少", tight.ok && tight.solve.best.totalWalkMeters <= baseMeters, tight.ok ? { tight: tight.solve.best.totalWalkMeters, base: baseMeters } : null);
check("2d withinLimit 为 true 且 verdict 把人话还给他", tight.ok && tight.explanation.withinLimit === true && tight.explanation.verdict.includes(`在您定的 ${tightLimit} 米以内`), tight.ok ? tight.explanation.verdict : null);

/* 3. 因果回显：删了站就必须有 whyDropped，且文案含真实数字 */
if (tight.ok) {
  const dropped = tight.explanation.whyDropped;
  const fewerStops = tight.solve.best.stops.length < (free.ok ? free.solve.best.stops.length : 0);
  check("3 减少站点时给出 whyDropped 且带真实数字", !fewerStops || dropped.length > 0, { stops: tight.solve.best.stops.length, dropped: dropped.length });
  check("3b whyDropped 文案含上限数字与总步行数字", dropped.every((item) => item.text.includes(String(tightLimit)) && /\d+ 米/.test(item.text)), dropped.map((d) => d.text));
  check("3c 被删的站确实不在当前行程里", dropped.every((item) => !tight.solve.best.stops.some((s) => s.flyaiId === item.id)));
  check("3d withoutLimit 记录了放宽后的对照值", tight.explanation.withoutLimit && tight.explanation.withoutLimit.totalWalkMeters >= tight.solve.best.totalWalkMeters, tight.explanation.withoutLimit);
}

/* 4. 上限压到不可能：必须如实失败 + 给经枚举验证的建议值 */
const impossible = solveSolo(facts, { maxWalkMeters: 200, mustVisit: [], neverAccept: [] }, NOW);
check("4 上限压到 200 米时如实报告排不出", impossible.ok === false, impossible.ok ? "unexpected ok" : impossible.kind);
if (!impossible.ok) {
  check("4b 无解时给出可行建议值", impossible.suggestion !== null, impossible.suggestion);
  if (impossible.suggestion) {
    const verify = solveSolo(facts, { maxWalkMeters: impossible.suggestion.maxWalkMeters, mustVisit: [], neverAccept: [] }, NOW);
    check("4c 建议值经二次求解验证确实可行", verify.ok === true && verify.solve.best.totalWalkMeters <= impossible.suggestion.maxWalkMeters, { suggestion: impossible.suggestion, actual: verify.ok ? verify.solve.best.totalWalkMeters : null });
  }
  check("4d 无解说明里带着建议上限", /放宽到 \d+ 米/.test(impossible.reason), impossible.reason.slice(0, 120));
}

/* 4e. 最少站数：1 站不得当可行行程放行 */
check("4e 建议值至少给出 SOC 最少站数", !impossible.ok && (!impossible.suggestion || impossible.suggestion.stopCount >= 2), !impossible.ok ? impossible.suggestion : null);

/* 5. 必须去：在已测范围内应被保留并写明原因 */
const firstId = free.ok ? free.solve.best.stops[0].flyaiId : "c1";
const must = solveSolo(facts, { maxWalkMeters: null, mustVisit: [firstId], neverAccept: [] }, NOW);
check("5 必须去的站出现在行程里", must.ok && must.solve.best.stops.some((s) => s.flyaiId === firstId));
check("5b keptBecauseMust 写出站点名", must.ok && must.explanation.keptBecauseMust.length === 1, must.ok ? must.explanation.keptBecauseMust : null);

/* 6. 绝不接受：不应出现在行程里 */
const neverId = free.ok ? free.solve.best.stops[1].flyaiId : "c2";
const never = solveSolo(facts, { maxWalkMeters: null, mustVisit: [], neverAccept: [neverId] }, NOW);
check("6 绝不接受的站不出现在行程里", never.ok && !never.solve.best.stops.some((s) => s.flyaiId === neverId), never.ok ? never.solve.best.stops.map((s) => s.flyaiId) : never.reason);

/* 7. 必须去撞绝不接受：硬冲突，必须如实报告而不是给一条违规路线 */
const clash = solveSolo(facts, { maxWalkMeters: null, mustVisit: [firstId], neverAccept: [firstId] }, NOW);
check("7 必须去与绝不接受同站时报告硬冲突", clash.ok === false && (clash.kind === "hard-conflict" || clash.kind === "constraint-invalid"), clash.ok ? "unexpected ok" : clash.kind);

/* 8. 未核验的 id：不能静默忽略 */
const ghost = solveSolo(facts, { maxWalkMeters: null, mustVisit: ["ghost-id"], neverAccept: [] }, NOW);
check("8 不在候选全集的 id 被拒绝而非忽略", ghost.ok === false && ghost.kind === "constraint-invalid", ghost.ok ? "unexpected ok" : ghost.kind);

/* 9. 短名单外「必须去」：必须报缺测/不可行，绝不返回带未测段的单站假行程 */
const shortlisted = makeShortlistedFacts();
const outsideId = shortlisted.pool.find((item) => !facts.pool.some((known) => known.id === item.id))?.id;
const outside = outsideId
  ? solveSolo(shortlisted, { maxWalkMeters: null, mustVisit: [outsideId], neverAccept: [] }, NOW)
  : null;
check("9 短名单外的必须去不会硬凑成假行程", outside !== null && outside.ok === false, outside ? (outside.ok ? { fake: outside.solve.best.stops.map((s) => s.name) } : outside.kind) : "no outside id");
check("9b 上述情况说明里点明需要补测或不可行", outside !== null && !outside.ok && /补测|不可行|最少需要/.test(outside.reason), outside && !outside.ok ? outside.reason.slice(0, 100) : null);
check("9c 单人流不自动补测（extraLegsNeeded 只报告不执行）", outside !== null && !outside.ok && typeof outside.extraLegsNeeded === "number", outside && !outside.ok ? outside.extraLegsNeeded : null);

/* 10. 单人执行门禁 */
const okItinerary = free.ok ? free.solve.best : null;
const gatePass = canExecuteSolo(okItinerary, { maxWalkMeters: baseMeters + 1000, mustVisit: [], neverAccept: [] });
check("10 满足约束时单人可执行", gatePass.allowed === true, gatePass.reason);
const gateTight = canExecuteSolo(okItinerary, { maxWalkMeters: 200, mustVisit: [], neverAccept: [] });
check("10b 超出上限时单人门禁拒绝并说明原因", gateTight.allowed === false && /超出/.test(gateTight.reason), gateTight.reason);
const gateMissing = canExecuteSolo(okItinerary, { maxWalkMeters: null, mustVisit: ["not-in-route"], neverAccept: [] });
check("10c 缺少必须去站点时门禁拒绝", gateMissing.allowed === false && /缺少/.test(gateMissing.reason), gateMissing.reason);
const gateEmpty = canExecuteSolo(null, { maxWalkMeters: null, mustVisit: [], neverAccept: [] });
check("10d 没有行程时门禁拒绝", gateEmpty.allowed === false);
const unverifiedItinerary = okItinerary ? { ...okItinerary, stops: okItinerary.stops.map((s) => ({ ...s, matchStatus: "unverified" })) } : null;
const gateUnverified = canExecuteSolo(unverifiedItinerary, { maxWalkMeters: null, mustVisit: [], neverAccept: [] });
check("10e 有未核验站点时门禁拒绝", gateUnverified.allowed === false && /未通过/.test(gateUnverified.reason), gateUnverified.reason);

/* 11. 纯函数性质：同样的输入，反复求解结果一致（无隐藏状态/无 IO） */
const again = solveSolo(facts, { maxWalkMeters: tightLimit, mustVisit: [], neverAccept: [] }, NOW);
check("11 同样输入重复求解结果一致", tight.ok && again.ok && again.solve.best.totalWalkMeters === tight.solve.best.totalWalkMeters && again.explanation.verdict === tight.explanation.verdict);

/* 12. COST_SCOPE_NOTICE 必须原样出现在求解说明里 */
check("12 统计口径说明原样保留", free.ok && free.solve.note.includes("不含回程") && free.solve.note.includes("产品设定"));

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} 单人重解纯函数检查通过`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
