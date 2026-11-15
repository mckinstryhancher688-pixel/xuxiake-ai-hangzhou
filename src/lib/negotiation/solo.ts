import type { VerifiedItinerary } from "@/lib/types";
import { solveJoint } from "./solve.ts";
import {
  emptyConditions,
  FACT_START_KEY,
  type ConditionHit,
  type FactSet,
  type HardConstraints,
  type JointSolve,
} from "./types.ts";

/**
 * 单人「事实层免费重解」（亲情场景 A 方案）。
 *
 * 核验已经付费测完全部有向路段，之后改「爸妈能走多远」只是换一个求解目标，
 * 不新增任何高德调用。这里的所有函数都是纯函数、不做 IO，便于离线单测。
 */

export interface SoloConstraints {
  maxWalkMeters: number | null;
  /** 一口气能走完的最长一段（米）；与总步行是两个独立约束 */
  maxSegmentMeters: number | null;
  mustVisit: string[];
  neverAccept: string[];
}

export interface SoloExecution {
  allowed: boolean;
  reason: string;
}

export interface DroppedStop {
  /** 站点飞猪 id；null 表示这是「不设上限时也不在最优解里」的一般性排除 */
  id: string | null;
  name: string;
  /** 面向用户的一句话，数字全部来自两次真实求解，不含猜测 */
  text: string;
}

export interface SoloExplanation {
  /** 服务端计算的总步行；前端不得自行比较 */
  totalWalkMeters: number;
  limit: number | null;
  /** limit 为 null 时恒为 true（没设上限就无所谓超没超） */
  withinLimit: boolean;
  /** 这条行程里最长的一段连续步行（米） */
  longestSegmentMeters: number;
  /** 单段上限；null 表示没设 */
  segmentLimit: number | null;
  /** segmentLimit 为 null 时恒为 true */
  withinSegmentLimit: boolean;
  /** 人话回显：把用户自己设的线还给他 */
  verdict: string;
  /** 因果回显：哪条约束拿掉了哪个站 */
  whyDropped: DroppedStop[];
  /** 因为「必须去」而保留的站 */
  keptBecauseMust: string[];
  /** 没设上限时会是什么样（用于解释上限的作用，null 表示没算或不适用） */
  withoutLimit: { totalWalkMeters: number; stopCount: number } | null;
}

export interface SoloCandidate {
  ok: true;
  solve: JointSolve;
  explanation: SoloExplanation;
}

export interface SoloFailure {
  ok: false;
  reason: string;
  kind: "constraint-invalid" | "hard-conflict" | "not-measured" | "no-solution" | "needs-payment";
  /** 无解时给出的可行建议（经枚举验证确实可行）；null 表示没有 */
  suggestion: { maxWalkMeters: number; stopCount: number; totalWalkMeters: number } | null;
  /** 需要补测才能回答时的缺边与条数；单人流不自动花钱 */
  missingEdges: JointSolve["missingEdges"];
  extraLegsNeeded: number;
  unmet: ConditionHit[];
}

export type SoloSolve = SoloCandidate | SoloFailure;

/**
 * 单人流的最少站数。双人求解器允许 1 站（JOINT_MIN_STOPS=1），
 * 但「半日游只有 1 个站」对亲情场景没有意义，也会把「必须去短名单外的站」
 * 伪装成一条可行路线（实测：mustVisit=短名单外站点时返回单站 + 8 段未测）。
 */
export const SOLO_MIN_STOPS = 2;

function toPartyConditions(role: "A" | "B", constraints: SoloConstraints) {
  const base = emptyConditions(role);
  const hard: HardConstraints = {
    ...base.hard,
    maxWalkMeters: constraints.maxWalkMeters,
    maxSegmentMeters: constraints.maxSegmentMeters,
    mustVisit: [...constraints.mustVisit],
    neverAccept: [...constraints.neverAccept],
  };
  return { ...base, hard };
}

/**
 * 单人执行门禁：与双人 canExecute 完全分开。
 * 双人要求「双方确认同一版本」；单人没有第二方，只要求事实与约束都成立。
 * 刻意不复用 canExecute —— 那是双人专用语义，混用会让两边都变模糊。
 */
export function canExecuteSolo(
  itinerary: VerifiedItinerary | null,
  constraints: SoloConstraints,
): SoloExecution {
  if (!itinerary || !itinerary.stops.length) {
    return { allowed: false, reason: "还没有排出行程。" };
  }
  for (const stop of itinerary.stops) {
    if (stop.matchStatus === "unverified") {
      return { allowed: false, reason: `「${stop.name}」的高德身份核验未通过，不能作为正式行程。` };
    }
    if (stop.openingStatus === "conflict") {
      return { allowed: false, reason: `「${stop.name}」在假定时间窗口内确认不开放（${stop.openingNote}），需要改时间或换站。` };
    }
  }
  const limit = constraints.maxWalkMeters;
  if (limit !== null && itinerary.totalWalkMeters > limit) {
    return {
      allowed: false,
      reason: `全程步行 ${itinerary.totalWalkMeters} 米，超出你定的 ${limit} 米上限。`,
    };
  }
  const longest = longestSegmentMeters(itinerary);
  const segCap = constraints.maxSegmentMeters;
  if (segCap !== null && longest > segCap) {
    return {
      allowed: false,
      reason: `最长一段连续步行 ${longest} 米，超出你定的单段上限 ${segCap} 米。`,
    };
  }
  const ids = new Set(itinerary.stops.map((stop) => stop.flyaiId));
  for (const id of constraints.mustVisit) {
    if (!ids.has(id)) return { allowed: false, reason: `行程里缺少必须去的站点「${id}」。` };
  }
  for (const id of constraints.neverAccept) {
    if (ids.has(id)) return { allowed: false, reason: `行程里出现了绝不接受的站点「${id}」。` };
  }
  const minutes = `${itinerary.totalWalkMeters} 米`;
  const within = limit === null ? "" : `，在你定的 ${limit} 米以内`;
  const segText = segCap === null ? "" : `；最长一段 ${longest} 米，不超 ${segCap} 米`;
  return { allowed: true, reason: `全程步行 ${minutes}${within}${segText}，站点身份与开放时间都已核验。` };
}

/** 一条行程里最长的那段连续步行（米）。总量达标也可能中间有一段走不动。 */
export function longestSegmentMeters(itinerary: Pick<VerifiedItinerary, "legs">): number {
  return itinerary.legs.reduce((max, leg) => Math.max(max, leg.distanceMeters), 0);
}

function verdictText(
  totalWalkMeters: number,
  limit: number | null,
  longestSegmentMeters: number,
  segmentLimit: number | null,
): string {
  const total =
    limit === null
      ? `这条路线全天走 ${totalWalkMeters} 米（你没有设走路上限）`
      : totalWalkMeters <= limit
        ? `这条路线全天走 ${totalWalkMeters} 米，在您定的 ${limit} 米以内`
        : `这条路线全天走 ${totalWalkMeters} 米，已经超过您定的 ${limit} 米——请把上限调高或减少站点`;
  const segment =
    segmentLimit === null
      ? ""
      : longestSegmentMeters <= segmentLimit
        ? `；最长一段走 ${longestSegmentMeters} 米，在您定的单段 ${segmentLimit} 米以内`
        : `；最长一段要走 ${longestSegmentMeters} 米，超过您定的单段 ${segmentLimit} 米`;
  return `${total}${segment}。`;
}

/** 无解时枚举一个「放宽到多少米就能成」的建议值；只从真实求解结果里取，不拍脑袋。 */
function suggestLimit(facts: FactSet, constraints: SoloConstraints): SoloFailure["suggestion"] {
  const probe = (limit: number | null) => {
    const solve = solveJoint(facts, toPartyConditions("A", { ...constraints, maxWalkMeters: limit }), null, new Date());
    if (!solve.best || solve.extraLegsNeeded > 0) return null;
    if (solve.best.stops.length < SOLO_MIN_STOPS) return null;
    return solve.best;
  };
  // 先试「完全不设上限」：如果连它都不行，说明问题不在上限
  const relaxed = probe(null);
  if (relaxed) {
    return { maxWalkMeters: relaxed.totalWalkMeters, stopCount: relaxed.stops.length, totalWalkMeters: relaxed.totalWalkMeters };
  }
  const candidates = facts.pool
    .map((item) => facts.legs[`${FACT_START_KEY}->${item.id}`]?.leg.distanceMeters)
    .filter((value): value is number => typeof value === "number");
  for (const meters of [...new Set(candidates)].sort((a, b) => a - b)) {
    const best = probe(meters);
    if (best) {
      return { maxWalkMeters: Math.max(meters, best.totalWalkMeters), stopCount: best.stops.length, totalWalkMeters: best.totalWalkMeters };
    }
  }
  return null;
}

export function solveSolo(
  facts: FactSet,
  constraints: SoloConstraints,
  now: Date = new Date(),
): SoloSolve {
  const party = toPartyConditions("A", constraints);
  const solve = solveJoint(facts, party, null, now);

  /**
   * 闸一：缺测。solveJoint 在「必须去短名单外的站」时会返回单站 + 一堆 missinedEdges，
   * 却仍标成 found —— 双人流程靠状态机去报价，单人流必须自己拦：
   * 只要还有必然缺的段，就不能拿它当可行行程，更不能自己偷偷去补测。
   */
  const cannotAnswer = solve.extraLegsNeeded > 0 || (solve.missingEdges.length > 0 && !solve.best);
  if (!solve.best || cannotAnswer) {
    if (solve.kind === "constraint-invalid") {
      return { ok: false, kind: "constraint-invalid", reason: solve.note, suggestion: null, missingEdges: solve.missingEdges, extraLegsNeeded: solve.extraLegsNeeded, unmet: solve.unmet };
    }
    if (solve.kind === "hard-conflict") {
      // 「已证实不可行」也算无解，要给出经枚举验证的建议值
      const suggestion = constraints.maxWalkMeters === null ? null : suggestLimit(facts, constraints);
      const reason = suggestion
        ? `${solve.note} 放宽到 ${suggestion.maxWalkMeters} 米可以排 ${suggestion.stopCount} 站（全程 ${suggestion.totalWalkMeters} 米）。`
        : solve.note;
      return { ok: false, kind: "hard-conflict", reason, suggestion, missingEdges: solve.missingEdges, extraLegsNeeded: solve.extraLegsNeeded, unmet: solve.unmet };
    }
    if (solve.extraLegsNeeded > 0 || solve.kind === "not-measured") {
      return {
        ok: false,
        kind: "needs-payment",
        reason:
          `${solve.note} 要让这个条件成立，还需要补测 ${solve.extraLegsNeeded || solve.missingEdges.length} 条步行段；` +
          "补测会真实消耗高德调用，这里不自动花钱，也不拿没测过的路段假装可行。",
        suggestion: null,
        missingEdges: solve.missingEdges,
        extraLegsNeeded: solve.extraLegsNeeded,
        unmet: solve.unmet,
      };
    }
    const suggestion = constraints.maxWalkMeters === null ? null : suggestLimit(facts, constraints);
    const reason = suggestion
      ? `${solve.note} 放宽到 ${suggestion.maxWalkMeters} 米可以排 ${suggestion.stopCount} 站（全程 ${suggestion.totalWalkMeters} 米）。`
      : solve.note;
    return { ok: false, kind: "no-solution", reason, suggestion, missingEdges: solve.missingEdges, extraLegsNeeded: solve.extraLegsNeeded, unmet: solve.unmet };
  }

  /**
   * 闸二：最少站数。「半日游只有 1 站」不是可用行程；
   * 这条同时防住「必须去短名单外的站 → 缩成单站蒙混过关」。
   */
  if (solve.best.stops.length < SOLO_MIN_STOPS) {
    // 注意：这里不能递归调 solveSolo —— 递归条件（去掉 mustVisit）可能和当前完全相同，
    // 会无限递归。直接问一次求解器就够了。
    const withoutMust = solveJoint(facts, toPartyConditions("A", { ...constraints, mustVisit: [] }), null, now);
    const safeBest = withoutMust.best && withoutMust.best.stops.length >= SOLO_MIN_STOPS && withoutMust.extraLegsNeeded === 0
      ? withoutMust.best
      : null;

    /* 站数不够时，要说清是哪条限制导致的：只报「站太少」会让用户不知道该改哪个数。 */
    const causes: string[] = [];
    const segCap = constraints.maxSegmentMeters;
    if (segCap !== null) {
      const segRelaxed = solveJoint(facts, toPartyConditions("A", { ...constraints, maxSegmentMeters: null }), null, now);
      if (segRelaxed.best && segRelaxed.best.stops.length > solve.best.stops.length) {
        causes.push(`取消单段上限后能排到 ${segRelaxed.best.stops.length} 站，说明是「一口气最多走 ${segCap} 米」把站点压掉了`);
      }
    }
    const cap = constraints.maxWalkMeters;
    if (cap !== null) {
      const capRelaxed = solveJoint(facts, toPartyConditions("A", { ...constraints, maxWalkMeters: null }), null, now);
      if (capRelaxed.best && capRelaxed.best.stops.length > solve.best.stops.length) {
        causes.push(`取消总步行上限后能排到 ${capRelaxed.best.stops.length} 站，说明是「全程 ${cap} 米」把站点压掉了`);
      }
    }

    const reason =
      `按当前条件最多只能排 ${solve.best.stops.length} 个站（${solve.best.stops.map((s) => s.name).join("、")}），` +
      `少于半日游最少需要的 ${SOLO_MIN_STOPS} 站。` +
      (causes.length ? `${causes.join("；")}。` : "") +
      (safeBest ? ` 不做这些限制时，可以排 ${safeBest.stops.length} 站、全程 ${safeBest.totalWalkMeters} 米。` : "");
    return { ok: false, kind: "no-solution", reason, suggestion: null, missingEdges: solve.missingEdges, extraLegsNeeded: solve.extraLegsNeeded, unmet: solve.unmet };
  }

  const itinerary = solve.best;
  const limit = constraints.maxWalkMeters;
  const withinLimit = limit === null || itinerary.totalWalkMeters <= limit;
  const longestSegment = longestSegmentMeters(itinerary);
  const segmentLimit = constraints.maxSegmentMeters;
  const withinSegmentLimit = segmentLimit === null || longestSegment <= segmentLimit;

  // 反事实：不设上限会排成什么样（纯本地枚举，0 调用）
  let withoutLimit: SoloExplanation["withoutLimit"] = null;
  if (limit !== null) {
    const relaxed = solveJoint(facts, toPartyConditions("A", { ...constraints, maxWalkMeters: null }), null, now);
    if (relaxed.best) {
      withoutLimit = { totalWalkMeters: relaxed.best.totalWalkMeters, stopCount: relaxed.best.stops.length };
    }
  }

  const kept = new Set(itinerary.stops.map((stop) => stop.flyaiId));
  const whyDropped: DroppedStop[] = [];

  // 上限删站：把「没设上限时出现、设了上限后消失」的站逐个说明
  if (withoutLimit && withoutLimit.stopCount > itinerary.stops.length) {
    const relaxed = solveJoint(facts, toPartyConditions("A", { ...constraints, maxWalkMeters: null }), null, now);
    for (const stop of relaxed.best?.stops ?? []) {
      if (kept.has(stop.flyaiId)) continue;
      whyDropped.push({
        id: stop.flyaiId,
        name: stop.name,
        text: `保留「${stop.name}」全程会走到 ${withoutLimit.totalWalkMeters} 米，超出你定的 ${limit} 米，所以这次没排它。`,
      });
    }
  }

  const keptBecauseMust: string[] = [];
  for (const id of constraints.mustVisit) {
    const stop = itinerary.stops.find((item) => item.flyaiId === id);
    if (stop) keptBecauseMust.push(stop.name);
  }

  return {
    ok: true,
    solve,
    explanation: {
      totalWalkMeters: itinerary.totalWalkMeters,
      limit,
      withinLimit,
      longestSegmentMeters: longestSegment,
      segmentLimit,
      withinSegmentLimit,
      verdict: verdictText(itinerary.totalWalkMeters, limit, longestSegment, segmentLimit),
      whyDropped,
      keptBecauseMust,
      withoutLimit,
    },
  };
}
