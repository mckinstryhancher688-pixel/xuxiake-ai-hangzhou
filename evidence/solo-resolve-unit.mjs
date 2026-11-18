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
const free = solveSolo(facts, { maxWalkMeters: null, maxSegmentMeters: null, mustVisit: [], neverAccept: [] }, NOW);
check("1 不设上限也能解出行程", free.ok === true && Boolean(free.solve.best), free.ok ? undefined : free.reason);
check("1b 不设上限时 withinLimit 恒为 true", free.ok && free.explanation.withinLimit === true);
check("1c verdict 如实写出总步行且不设上限", free.ok && /全天走 \d+ 米/.test(free.explanation.verdict) && free.explanation.verdict.includes("没有设走路上限"), free.ok ? free.explanation.verdict : null);

/* 2. 收紧上限：只减不增，且服务端自己判定在限内 */
const baseMeters = free.ok ? free.explanation.totalWalkMeters : 0;
const tightLimit = Math.max(200, Math.floor(baseMeters * 0.5));
const tight = solveSolo(facts, { maxWalkMeters: tightLimit, maxSegmentMeters: null, mustVisit: [], neverAccept: [] }, NOW);
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
const impossible = solveSolo(facts, { maxWalkMeters: 200, maxSegmentMeters: null, mustVisit: [], neverAccept: [] }, NOW);
check("4 上限压到 200 米时如实报告排不出", impossible.ok === false, impossible.ok ? "unexpected ok" : impossible.kind);
if (!impossible.ok) {
  check("4b 无解时给出可行建议值", impossible.suggestion !== null, impossible.suggestion);
  if (impossible.suggestion) {
    const verify = solveSolo(facts, { maxWalkMeters: impossible.suggestion.maxWalkMeters, maxSegmentMeters: null, mustVisit: [], neverAccept: [] }, NOW);
    check("4c 建议值经二次求解验证确实可行", verify.ok === true && verify.solve.best.totalWalkMeters <= impossible.suggestion.maxWalkMeters, { suggestion: impossible.suggestion, actual: verify.ok ? verify.solve.best.totalWalkMeters : null });
  }
  check("4d 无解说明里带着建议上限", /放宽到 \d+ 米/.test(impossible.reason), impossible.reason.slice(0, 120));
}

/* 4e. 最少站数：1 站不得当可行行程放行 */
check("4e 建议值至少给出 SOC 最少站数", !impossible.ok && (!impossible.suggestion || impossible.suggestion.stopCount >= 2), !impossible.ok ? impossible.suggestion : null);

/* 5. 必须去：在已测范围内应被保留并写明原因 */
const firstId = free.ok ? free.solve.best.stops[0].flyaiId : "c1";
const must = solveSolo(facts, { maxWalkMeters: null, maxSegmentMeters: null, mustVisit: [firstId], neverAccept: [] }, NOW);
check("5 必须去的站出现在行程里", must.ok && must.solve.best.stops.some((s) => s.flyaiId === firstId));
check("5b keptBecauseMust 写出站点名", must.ok && must.explanation.keptBecauseMust.length === 1, must.ok ? must.explanation.keptBecauseMust : null);

/* 6. 绝不接受：不应出现在行程里 */
const neverId = free.ok ? free.solve.best.stops[1].flyaiId : "c2";
const never = solveSolo(facts, { maxWalkMeters: null, maxSegmentMeters: null, mustVisit: [], neverAccept: [neverId] }, NOW);
check("6 绝不接受的站不出现在行程里", never.ok && !never.solve.best.stops.some((s) => s.flyaiId === neverId), never.ok ? never.solve.best.stops.map((s) => s.flyaiId) : never.reason);

/* 7. 必须去撞绝不接受：硬冲突，必须如实报告而不是给一条违规路线 */
const clash = solveSolo(facts, { maxWalkMeters: null, maxSegmentMeters: null, mustVisit: [firstId], neverAccept: [firstId] }, NOW);
check("7 必须去与绝不接受同站时报告硬冲突", clash.ok === false && (clash.kind === "hard-conflict" || clash.kind === "constraint-invalid"), clash.ok ? "unexpected ok" : clash.kind);

/* 8. 未核验的 id：不能静默忽略 */
const ghost = solveSolo(facts, { maxWalkMeters: null, maxSegmentMeters: null, mustVisit: ["ghost-id"], neverAccept: [] }, NOW);
check("8 不在候选全集的 id 被拒绝而非忽略", ghost.ok === false && ghost.kind === "constraint-invalid", ghost.ok ? "unexpected ok" : ghost.kind);

/* 9. 短名单外「必须去」：必须报缺测/不可行，绝不返回带未测段的单站假行程 */
const shortlisted = makeShortlistedFacts();
const outsideId = shortlisted.pool.find((item) => !facts.pool.some((known) => known.id === item.id))?.id;
const outside = outsideId
  ? solveSolo(shortlisted, { maxWalkMeters: null, maxSegmentMeters: null, mustVisit: [outsideId], neverAccept: [] }, NOW)
  : null;
check("9 短名单外的必须去不会硬凑成假行程", outside !== null && outside.ok === false, outside ? (outside.ok ? { fake: outside.solve.best.stops.map((s) => s.name) } : outside.kind) : "no outside id");
check("9b 上述情况说明里点明需要补测或不可行", outside !== null && !outside.ok && /补测|不可行|最少需要/.test(outside.reason), outside && !outside.ok ? outside.reason.slice(0, 100) : null);
check("9c 单人流不自动补测（extraLegsNeeded 只报告不执行）", outside !== null && !outside.ok && typeof outside.extraLegsNeeded === "number", outside && !outside.ok ? outside.extraLegsNeeded : null);

/* 10. 单人执行门禁 */
const okItinerary = free.ok ? free.solve.best : null;
const gatePass = canExecuteSolo(okItinerary, { maxWalkMeters: baseMeters + 1000, maxSegmentMeters: null, mustVisit: [], neverAccept: [] });
check("10 满足约束时单人可执行", gatePass.allowed === true, gatePass.reason);
const gateTight = canExecuteSolo(okItinerary, { maxWalkMeters: 200, maxSegmentMeters: null, mustVisit: [], neverAccept: [] });
check("10b 超出上限时单人门禁拒绝并说明原因", gateTight.allowed === false && /超出/.test(gateTight.reason), gateTight.reason);
const gateMissing = canExecuteSolo(okItinerary, { maxWalkMeters: null, maxSegmentMeters: null, mustVisit: ["not-in-route"], neverAccept: [] });
check("10c 缺少必须去站点时门禁拒绝", gateMissing.allowed === false && /缺少/.test(gateMissing.reason), gateMissing.reason);
const gateEmpty = canExecuteSolo(null, { maxWalkMeters: null, maxSegmentMeters: null, mustVisit: [], neverAccept: [] });
check("10d 没有行程时门禁拒绝", gateEmpty.allowed === false);
const unverifiedItinerary = okItinerary ? { ...okItinerary, stops: okItinerary.stops.map((s) => ({ ...s, matchStatus: "unverified" })) } : null;
const gateUnverified = canExecuteSolo(unverifiedItinerary, { maxWalkMeters: null, maxSegmentMeters: null, mustVisit: [], neverAccept: [] });
check("10e 有未核验站点时门禁拒绝", gateUnverified.allowed === false && /未通过/.test(gateUnverified.reason), gateUnverified.reason);

/* 11. 纯函数性质：同样的输入，反复求解结果一致（无隐藏状态/无 IO） */
const again = solveSolo(facts, { maxWalkMeters: tightLimit, maxSegmentMeters: null, mustVisit: [], neverAccept: [] }, NOW);
check("11 同样输入重复求解结果一致", tight.ok && again.ok && again.solve.best.totalWalkMeters === tight.solve.best.totalWalkMeters && again.explanation.verdict === tight.explanation.verdict);

/* 12. COST_SCOPE_NOTICE 必须原样出现在求解说明里 */
check("12 统计口径说明原样保留", free.ok && free.solve.note.includes("不含回程") && free.solve.note.includes("产品设定"));

/* 13. 单段最长步行：与总步行是两个独立约束 */
const baseLongest = free.ok ? Math.max(...free.solve.best.legs.map((l) => l.distanceMeters)) : 0;
const segLoose = solveSolo(facts, { maxWalkMeters: null, maxSegmentMeters: baseLongest + 500, mustVisit: [], neverAccept: [] }, NOW);
check("13 单段上限放宽时仍能解出行程", segLoose.ok === true, segLoose.ok ? undefined : segLoose.reason);
check("13b 回显里带了最长一段的实测米数", segLoose.ok && segLoose.explanation.longestSegmentMeters > 0 && /最长一段走 \d+ 米/.test(segLoose.explanation.verdict), segLoose.ok ? segLoose.explanation.verdict : null);
check("13c 单段上限满足时 withinSegmentLimit=true", segLoose.ok && segLoose.explanation.withinSegmentLimit === true);

/* 14. 把单段压到最小值以下：必须解不出或缩到更短段，且如实说明 */
const tightSeg = solveSolo(facts, { maxWalkMeters: null, maxSegmentMeters: 400, mustVisit: [], neverAccept: [] }, NOW);
if (tightSeg.ok) {
  check("14 压紧单段后解出的行程每段都不超上限", tightSeg.solve.best.legs.every((l) => l.distanceMeters <= 400), {
    longest: Math.max(...tightSeg.solve.best.legs.map((l) => l.distanceMeters)),
  });
} else {
  check("14 压紧单段排不出时如实说明且提到单段", /单段|连续步行/.test(tightSeg.reason), tightSeg.reason.slice(0, 100));
}

/* 15. 总量很宽但单段很紧：证明两个约束各自独立生效 */
const wideTotalTightSeg = solveSolo(facts, { maxWalkMeters: 40000, maxSegmentMeters: 400, mustVisit: [], neverAccept: [] }, NOW);
const totalOnly = solveSolo(facts, { maxWalkMeters: 40000, maxSegmentMeters: null, mustVisit: [], neverAccept: [] }, NOW);
if (wideTotalTightSeg.ok && totalOnly.ok) {
  const a = Math.max(...wideTotalTightSeg.solve.best.legs.map((l) => l.distanceMeters));
  const b = Math.max(...totalOnly.solve.best.legs.map((l) => l.distanceMeters));
  check("15 单段约束独立生效（总量不变但段更短或站更少）", a <= 400 && a <= b, { segTightLongest: a, noSegLongest: b });
} else {
  check("15 单段约束独立生效（至少有一侧如实拒绝）", true, { tightOk: wideTotalTightSeg.ok, looseOk: totalOnly.ok });
}

/* 16. 单段门禁 */
const segItinerary = free.ok ? free.solve.best : null;
const segGatePass = canExecuteSolo(segItinerary, { maxWalkMeters: null, maxSegmentMeters: baseLongest + 1, mustVisit: [], neverAccept: [] });
check("16 单段上限满足时门禁放行", segGatePass.allowed === true, segGatePass.reason);
const segGateFail = canExecuteSolo(segItinerary, { maxWalkMeters: null, maxSegmentMeters: Math.max(200, baseLongest - 100), mustVisit: [], neverAccept: [] });
check("16b 单段超标时门禁拒绝并说明", segGateFail.allowed === false && /最长一段/.test(segGateFail.reason), segGateFail.reason);

/* ───── 17+. 总步行「分钟」上限：直接对高德实测的每段分钟求和，不经过米数换算 ─────
 * 夹具里各段分钟数是人工给定的，所以期望值可以手算：
 *   不设限最优 = 起点→集贤亭 4 → 湖滨步行街 6 → 圣塘景区 8 → 断桥残雪 12 = 4 站 / 30 分钟
 *   最短 3 站 = 4 + 6 + 8 = 18 分钟；最短 2 站 = 4 + 6 = 10 分钟
 */
const none = { maxWalkMeters: null, maxSegmentMeters: null, mustVisit: [], neverAccept: [] };
const freeMinutes = free.ok ? free.solve.best.totalWalkMinutes : -1;
check("17 不设限时夹具最优是 4 站 / 30 分钟（手算期望）", free.ok && free.solve.best.stops.length === 4 && freeMinutes === 30, free.ok ? { stops: free.solve.best.stops.length, minutes: freeMinutes } : null);
check("17b 解释里带着服务端累加的实测分钟，且与行程一致", free.ok && free.explanation.totalWalkMinutes === freeMinutes && free.explanation.limitMinutes === null && free.explanation.withinMinutesLimit === true, free.ok ? free.explanation.totalWalkMinutes : null);
check("17c 不设限的回显里写明步行约多少分钟", free.ok && free.explanation.verdict.includes(`步行约 ${freeMinutes} 分钟`), free.ok ? free.explanation.verdict : null);

const undefMinutes = solveSolo(facts, { ...none, maxWalkMinutes: undefined }, NOW);
check("17d 旧调用方不传 maxWalkMinutes 与传 null 结果一致", free.ok && undefMinutes.ok && undefMinutes.explanation.verdict === free.explanation.verdict);

/* 18. 分钟上限放宽：不影响结果，回显用用户定的口径 */
const minutesLoose = solveSolo(facts, { ...none, maxWalkMinutes: 60 }, NOW);
check("18 上限 60 分钟时仍排 4 站", minutesLoose.ok && minutesLoose.solve.best.stops.length === 4, minutesLoose.ok ? minutesLoose.solve.best.stops.length : minutesLoose.reason);
check("18b withinMinutesLimit=true 且回显写「在您定的 60 分钟以内」", minutesLoose.ok && minutesLoose.explanation.withinMinutesLimit === true && minutesLoose.explanation.verdict.includes("在您定的 60 分钟以内"), minutesLoose.ok ? minutesLoose.explanation.verdict : null);
check("18c 没设米数时 limit 仍是 null（两个口径互不串味）", minutesLoose.ok && minutesLoose.explanation.limit === null && minutesLoose.explanation.limitMinutes === 60);

/* 19. 分钟上限收紧到 20：只能排 3 站（最短 3 站 = 18 分钟），并说明为什么少了一站 */
const minutesTight = solveSolo(facts, { ...none, maxWalkMinutes: 20 }, NOW);
check("19 上限 20 分钟时排 3 站且总步行不超过 20 分钟", minutesTight.ok && minutesTight.solve.best.stops.length === 3 && minutesTight.solve.best.totalWalkMinutes <= 20, minutesTight.ok ? { stops: minutesTight.solve.best.stops.length, minutes: minutesTight.solve.best.totalWalkMinutes } : minutesTight.reason);
check("19b 总步行分钟比不设限更少", minutesTight.ok && minutesTight.solve.best.totalWalkMinutes < freeMinutes);
check("19c 少排的那一站有 whyDropped，文案用分钟且含两个真实数字", minutesTight.ok && minutesTight.explanation.whyDropped.length === 1 && minutesTight.explanation.whyDropped[0].text.includes("30 分钟") && minutesTight.explanation.whyDropped[0].text.includes("20 分钟"), minutesTight.ok ? minutesTight.explanation.whyDropped.map((d) => d.text) : null);
check("19d withoutLimit 记录了放宽后的分钟对照", minutesTight.ok && minutesTight.explanation.withoutLimit?.totalWalkMinutes === 30 && minutesTight.explanation.withoutLimit?.stopCount === 4, minutesTight.ok ? minutesTight.explanation.withoutLimit : null);

/* 20. 分钟上限压到只够 1 站：站数不足的闸门必须点名是分钟卡住，并给出经二分验证的「最少需要多少分钟」
 *     （夹具里 4 分钟能到集贤亭，所以 5 分钟能排 1 站但排不出 2 站） */
const minutesImpossible = solveSolo(facts, { ...none, maxWalkMinutes: 5 }, NOW);
check("20 上限 5 分钟时如实报告排不出", minutesImpossible.ok === false && minutesImpossible.kind === "no-solution", minutesImpossible.ok ? "unexpected ok" : minutesImpossible.kind);
check("20b 说明点名是「全程步行最多 5 分钟」把站点压掉", !minutesImpossible.ok && minutesImpossible.reason.includes("全程步行最多 5 分钟") && minutesImpossible.reason.includes("最多只能排 1 个站"), !minutesImpossible.ok ? minutesImpossible.reason.slice(0, 160) : null);
check("20c 建议值 = 最少 10 分钟排 2 站（手算期望）", !minutesImpossible.ok && minutesImpossible.suggestion?.maxWalkMinutes === 10 && minutesImpossible.suggestion?.stopCount === 2, !minutesImpossible.ok ? minutesImpossible.suggestion : null);
check("20c2 建议值里的米数是该行程的实测米数（不是分钟数串位）", !minutesImpossible.ok && minutesImpossible.suggestion?.maxWalkMeters === 800 && minutesImpossible.suggestion?.totalWalkMeters === 800, !minutesImpossible.ok ? minutesImpossible.suggestion : null);
check("20d 无解说明用分钟说「放宽到 10 分钟可以排 2 站」", !minutesImpossible.ok && minutesImpossible.reason.includes("放宽到 10 分钟可以排 2 站"), !minutesImpossible.ok ? minutesImpossible.reason.slice(-60) : null);

/* 20g. 压到连 1 站都到不了（最近的一站要 4 分钟）：走硬冲突分支，写出最短要多少分钟、差多少，仍给同一个建议 */
const minutesNothing = solveSolo(facts, { ...none, maxWalkMinutes: 3 }, NOW);
check("20g 上限 3 分钟（连最近一站都到不了）报硬冲突", minutesNothing.ok === false && minutesNothing.kind === "hard-conflict", minutesNothing.ok ? "unexpected ok" : minutesNothing.kind);
check("20h 写出最短也要 4 分钟、比上限 3 分钟多 1 分钟，且不是「没测到」", !minutesNothing.ok && minutesNothing.reason.includes("步行最短的一条也要 4 分钟，比本方上限 3 分钟多 1 分钟"), !minutesNothing.ok ? minutesNothing.reason.slice(0, 200) : null);
check("20i 同样给出 10 分钟排 2 站的建议", !minutesNothing.ok && minutesNothing.suggestion?.maxWalkMinutes === 10 && minutesNothing.suggestion?.stopCount === 2, !minutesNothing.ok ? minutesNothing.suggestion : null);
if (!minutesImpossible.ok && minutesImpossible.suggestion) {
  const atSuggestion = solveSolo(facts, { ...none, maxWalkMinutes: minutesImpossible.suggestion.maxWalkMinutes }, NOW);
  const belowSuggestion = solveSolo(facts, { ...none, maxWalkMinutes: minutesImpossible.suggestion.maxWalkMinutes - 1 }, NOW);
  check("20e 建议值经二次求解确实可行", atSuggestion.ok === true && atSuggestion.solve.best.totalWalkMinutes <= minutesImpossible.suggestion.maxWalkMinutes);
  check("20f 建议值是最小值：再少 1 分钟就排不出", belowSuggestion.ok === false, belowSuggestion.ok ? "还能排，说明建议值不是最小" : belowSuggestion.kind);
}

/* 21. 分钟与「必须去」叠加：必须去雷峰塔（含它的最短 2 站链条 = 38 分钟） */
const mustFar = solveSolo(facts, { ...none, maxWalkMinutes: 20, mustVisit: ["c5"] }, NOW);
check("21 必须去的站让 20 分钟排不出时如实报告", mustFar.ok === false, mustFar.ok ? "unexpected ok" : mustFar.kind);
check("21b 建议值是含该站的最短链条 38 分钟", !mustFar.ok && mustFar.suggestion?.maxWalkMinutes === 38, !mustFar.ok ? mustFar.suggestion : null);

/* 22. 分钟门禁：独立于米数门禁 */
const minItinerary = free.ok ? free.solve.best : null;
const minGateFail = canExecuteSolo(minItinerary, { ...none, maxWalkMinutes: 20 });
check("22 超出分钟上限时单人门禁拒绝并用分钟说明", minGateFail.allowed === false && /30 分钟，超出你定的 20 分钟/.test(minGateFail.reason), minGateFail.reason);
const minGatePass = canExecuteSolo(minItinerary, { ...none, maxWalkMinutes: 30 });
check("22b 刚好等于上限时放行，并写明分钟", minGatePass.allowed === true && minGatePass.reason.includes("步行约 30 分钟，不超你定的 30 分钟"), minGatePass.reason);

/* 23. 同样输入重复求解一致（含二分建议值，无隐藏状态） */
const minutesImpossibleAgain = solveSolo(facts, { ...none, maxWalkMinutes: 5 }, NOW);
check("23 分钟上限的无解建议重复求解结果一致", !minutesImpossible.ok && !minutesImpossibleAgain.ok && JSON.stringify(minutesImpossible.suggestion) === JSON.stringify(minutesImpossibleAgain.suggestion));

/* ───── 24+. 每站停留时长（D2）：只换模拟停留，不改实测路段 ─────
 * 夹具手算：步行最短的 4 站 = 30 分钟，3 站 = 18 分钟；缓冲 20；半日 240。
 *   停留 30：4 站 → 30 + 120 + 20 = 170
 *   停留 45：4 站 → 30 + 180 + 20 = 230 ≤ 240，仍是 4 站
 *   停留 60：4 站 → 30 + 240 + 20 = 290 > 240；3 站 → 18 + 180 + 20 = 218，所以是 3 站
 *   停留 15：4 站 → 30 + 60 + 20 = 110
 */
const { withStayMinutes } = await import("../src/lib/negotiation/solo.ts");
const stayDefault = solveSolo(facts, { ...none }, NOW);
check("24 不传停留时长时沿用事实集的 30 分钟", stayDefault.ok && stayDefault.explanation.stayMinutes === 30 && stayDefault.solve.best.stops.every((s) => s.stayMinutes === 30), stayDefault.ok ? stayDefault.explanation.stayMinutes : null);

const stay45 = solveSolo(facts, { ...none, stayMinutes: 45 }, NOW);
check("24b 停留 45：仍排 4 站，合计 230 分钟（手算期望）", stay45.ok && stay45.solve.best.stops.length === 4 && stay45.solve.best.totalMinutes === 230 && stay45.solve.best.totalStayMinutes === 180, stay45.ok ? { stops: stay45.solve.best.stops.length, total: stay45.solve.best.totalMinutes } : stay45.reason);
check("24c 停留 45 没压站，所以没有停留说明", stay45.ok && stay45.explanation.stayNote === null, stay45.ok ? stay45.explanation.stayNote : null);

const stay60 = solveSolo(facts, { ...none, stayMinutes: 60 }, NOW);
check("25 停留 60：只能排 3 站，合计 218 分钟（手算期望）", stay60.ok && stay60.solve.best.stops.length === 3 && stay60.solve.best.totalMinutes === 218 && stay60.solve.best.totalStayMinutes === 180, stay60.ok ? { stops: stay60.solve.best.stops.length, total: stay60.solve.best.totalMinutes } : stay60.reason);
check("25b 每站的停留都写成 60 分钟", stay60.ok && stay60.solve.best.stops.every((s) => s.stayMinutes === 60));
check("25c 步行仍是高德实测的那几段（3 站最短 18 分钟）", stay60.ok && stay60.solve.best.totalWalkMinutes === 18, stay60.ok ? stay60.solve.best.totalWalkMinutes : null);
check("25d 停留压站时给出说明，两个站数都来自真实求解", stay60.ok && stay60.explanation.stayNote === "每站停留 60 分钟时，半日 240 分钟里最多排 3 站；每站停 15 分钟可以排 4 站。", stay60.ok ? stay60.explanation.stayNote : null);
check("25e 停留压站不能被记成步行上限删站", stay60.ok && stay60.explanation.whyDropped.length === 0, stay60.ok ? stay60.explanation.whyDropped : null);

const stay60walk20 = solveSolo(facts, { ...none, stayMinutes: 60, maxWalkMinutes: 20 }, NOW);
check("26 停留 60 + 步行 20 分钟：3 站，且不把原因记到停留上（停 15 分钟也还是 3 站）", stay60walk20.ok && stay60walk20.solve.best.stops.length === 3 && stay60walk20.explanation.stayNote === null, stay60walk20.ok ? { stops: stay60walk20.solve.best.stops.length, note: stay60walk20.explanation.stayNote } : stay60walk20.reason);

const stay60walk5 = solveSolo(facts, { ...none, stayMinutes: 60, maxWalkMinutes: 5 }, NOW);
check("27 停留 60 + 步行 5 分钟：排不出，原因只点名步行上限，不点名停留", !stay60walk5.ok && stay60walk5.reason.includes("全程步行最多 5 分钟") && !stay60walk5.reason.includes("每站停留 60 分钟"), !stay60walk5.ok ? stay60walk5.reason.slice(0, 200) : "unexpected ok");

check("28 求解不改动事实集原件（同一份事实集再按默认解一次，停留仍是 30）", (() => {
  const again30 = solveSolo(facts, { ...none }, NOW);
  return again30.ok && again30.solve.best.stops.every((s) => s.stayMinutes === 30) && facts.pool.every((s) => s.stayMinutes === 30);
})());
check("28b withStayMinutes 返回拷贝、实测路段原样共享", (() => {
  const copy = withStayMinutes(facts, 45);
  return copy !== facts && copy.legs === facts.legs && copy.pool.every((s) => s.stayMinutes === 45) && facts.pool.every((s) => s.stayMinutes === 30);
})());
check("28c withStayMinutes(null) 原样返回", withStayMinutes(facts, null) === facts && withStayMinutes(facts, undefined) === facts);

const stay15 = solveSolo(facts, { ...none, stayMinutes: 15 }, NOW);
check("29 停留 15：4 站，合计 110 分钟（手算期望）", stay15.ok && stay15.solve.best.stops.length === 4 && stay15.solve.best.totalMinutes === 110, stay15.ok ? stay15.solve.best.totalMinutes : stay15.reason);

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} 单人重解纯函数检查通过`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
