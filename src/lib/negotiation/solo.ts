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
 * 核验已经付费测完全部有向路段，之后改「爸妈全程一共能走多久」只是换一个求解目标，
 * 不新增任何高德调用。这里的所有函数都是纯函数、不做 IO，便于离线单测。
 */

export interface SoloConstraints {
  maxWalkMeters: number | null;
  /**
   * 全程步行最多多少分钟；缺省或 null 表示没设。直接对高德实测的每段步行分钟求和判定，
   * 不经过「米 ↔ 分钟」换算，所以界面上问「能走多久」时不需要替用户假设步速。
   */
  maxWalkMinutes?: number | null;
  /**
   * 每站停留多少分钟（模拟值，用户决定 D2 开放的唯一一档调节）；缺省或 null 沿用事实集里的值（默认 30）。
   * 它不改变任何实测路段，只改变「步行 + 停留 + 缓冲」是否放得进半日 240 分钟。
   */
  stayMinutes?: number | null;
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

/** 无解时给出的「放宽到多少就能成」：数字全部来自真实求解，经二次求解验证过。 */
export interface WalkSuggestion {
  maxWalkMeters: number;
  stopCount: number;
  totalWalkMeters: number;
  /** 满足条件所需的最小总步行分钟（按分钟设限时是最小值；按米设限时等于该行程的实测分钟） */
  maxWalkMinutes: number;
  totalWalkMinutes: number;
}

export interface SoloExplanation {
  /** 服务端计算的总步行；前端不得自行比较 */
  totalWalkMeters: number;
  /** 服务端累加的高德实测步行分钟 */
  totalWalkMinutes: number;
  limit: number | null;
  /** 总步行分钟上限；null 表示没设 */
  limitMinutes: number | null;
  /** limitMinutes 为 null 时恒为 true */
  withinMinutesLimit: boolean;
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
  withoutLimit: { totalWalkMeters: number; totalWalkMinutes: number; stopCount: number } | null;
  /** 这次求解用的每站停留分钟（模拟值） */
  stayMinutes: number;
  /** 停留时长把站数压下来时的一句说明（两次真实求解对比得出）；没有压站时为 null */
  stayNote: string | null;
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
  suggestion: WalkSuggestion | null;
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

/** 用来判断「是不是停留时长把站压掉了」的对照值：菜单里最短的一档。 */
const SHORTEST_STAY_MINUTES = 15;

/**
 * 把每站停留时长套到事实集的一份浅拷贝上。只换 pool 里的 stayMinutes，实测路段原样共享、不改动，
 * 所以事实层缓存里的那一份永远保持原值，同一份事实集可以按不同停留时长反复求解。
 */
export function withStayMinutes(facts: FactSet, stayMinutes: number | null | undefined): FactSet {
  if (stayMinutes === null || stayMinutes === undefined) return facts;
  if (facts.pool.every((stop) => stop.stayMinutes === stayMinutes)) return facts;
  return { ...facts, pool: facts.pool.map((stop) => ({ ...stop, stayMinutes })) };
}

function stayOf(facts: FactSet): number {
  return facts.pool[0]?.stayMinutes ?? 0;
}

function toPartyConditions(role: "A" | "B", constraints: SoloConstraints) {
  const base = emptyConditions(role);
  const hard: HardConstraints = {
    ...base.hard,
    maxWalkMeters: constraints.maxWalkMeters,
    maxWalkMinutes: constraints.maxWalkMinutes ?? null,
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
  const minutesLimit = constraints.maxWalkMinutes ?? null;
  if (minutesLimit !== null && itinerary.totalWalkMinutes > minutesLimit) {
    return {
      allowed: false,
      reason: `全程步行约 ${itinerary.totalWalkMinutes} 分钟，超出你定的 ${minutesLimit} 分钟上限。`,
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
  const minutesText = minutesLimit === null ? "" : `；步行约 ${itinerary.totalWalkMinutes} 分钟，不超你定的 ${minutesLimit} 分钟`;
  return { allowed: true, reason: `全程步行 ${minutes}${within}${minutesText}${segText}，站点身份与开放时间都已核验。` };
}

/** 一条行程里最长的那段连续步行（米）。总量达标也可能中间有一段走不动。 */
export function longestSegmentMeters(itinerary: Pick<VerifiedItinerary, "legs">): number {
  return itinerary.legs.reduce((max, leg) => Math.max(max, leg.distanceMeters), 0);
}

function verdictText(input: {
  totalWalkMeters: number;
  totalWalkMinutes: number;
  limit: number | null;
  limitMinutes: number | null;
  longestSegmentMeters: number;
  segmentLimit: number | null;
}): string {
  const { totalWalkMeters, totalWalkMinutes, limit, limitMinutes, longestSegmentMeters, segmentLimit } = input;
  let total: string;
  if (limitMinutes !== null) {
    // 按时间设限：先说分钟（用户自己定的口径），米数放在括号里做参考
    total = `这条路线全程步行约 ${totalWalkMinutes} 分钟（${totalWalkMeters} 米），` +
      (totalWalkMinutes <= limitMinutes
        ? `在您定的 ${limitMinutes} 分钟以内`
        : `已经超过您定的 ${limitMinutes} 分钟——请把上限调高或减少站点`);
    if (limit !== null) {
      total += totalWalkMeters <= limit ? `；也在您定的 ${limit} 米以内` : `；同时超过您定的 ${limit} 米`;
    }
  } else if (limit === null) {
    total = `这条路线全天走 ${totalWalkMeters} 米（你没有设走路上限），步行约 ${totalWalkMinutes} 分钟`;
  } else if (totalWalkMeters <= limit) {
    total = `这条路线全天走 ${totalWalkMeters} 米，在您定的 ${limit} 米以内`;
  } else {
    total = `这条路线全天走 ${totalWalkMeters} 米，已经超过您定的 ${limit} 米——请把上限调高或减少站点`;
  }
  const segment =
    segmentLimit === null
      ? ""
      : longestSegmentMeters <= segmentLimit
        ? `；最长一段走 ${longestSegmentMeters} 米，在您定的单段 ${segmentLimit} 米以内`
        : `；最长一段要走 ${longestSegmentMeters} 米，超过您定的单段 ${segmentLimit} 米`;
  return `${total}${segment}。`;
}

function hasWalkCap(constraints: SoloConstraints): boolean {
  return constraints.maxWalkMeters !== null || (constraints.maxWalkMinutes ?? null) !== null;
}

function suggestionOf(best: VerifiedItinerary, maxWalkMeters: number, maxWalkMinutes: number): WalkSuggestion {
  return {
    maxWalkMeters,
    stopCount: best.stops.length,
    totalWalkMeters: best.totalWalkMeters,
    maxWalkMinutes,
    totalWalkMinutes: best.totalWalkMinutes,
  };
}

/** 无解说明里「放宽到多少就能成」那句话；按用户设的是分钟还是米，用同一种单位说。 */
function suggestionSentence(constraints: SoloConstraints, suggestion: WalkSuggestion): string {
  return (constraints.maxWalkMinutes ?? null) !== null
    ? ` 放宽到 ${suggestion.maxWalkMinutes} 分钟可以排 ${suggestion.stopCount} 站（全程步行约 ${suggestion.totalWalkMinutes} 分钟）。`
    : ` 放宽到 ${suggestion.maxWalkMeters} 米可以排 ${suggestion.stopCount} 站（全程 ${suggestion.totalWalkMeters} 米）。`;
}

/**
 * 无解时给一个「放宽到多少就能成」的建议值；只从真实求解结果里取，不拍脑袋。
 * 按分钟设限时给的是「至少要多少分钟才排得出 ${SOLO_MIN_STOPS} 站」的最小值：
 * 可行性随上限单调（上限越大可行集越大），所以用二分在 1 ~ 不设限时的实测分钟之间找最小值，
 * 每一步都是一次真实求解。这样用户选了 30 分钟排不出时，看到的是「至少要 X 分钟」，而不是一个很大的数。
 */
function suggestLimit(facts: FactSet, constraints: SoloConstraints, now: Date): SoloFailure["suggestion"] {
  if ((constraints.maxWalkMinutes ?? null) !== null) {
    const probeMinutes = (minutes: number | null) => {
      const solve = solveJoint(facts, toPartyConditions("A", { ...constraints, maxWalkMinutes: minutes }), null, now);
      if (!solve.best || solve.extraLegsNeeded > 0) return null;
      if (solve.best.stops.length < SOLO_MIN_STOPS) return null;
      return solve.best;
    };
    // 先试「不设分钟上限」：如果连它都不行，说明问题不在分钟上限
    const loose = probeMinutes(null);
    if (!loose) return null;
    let lo = 1;
    let hi = loose.totalWalkMinutes;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (probeMinutes(mid)) hi = mid;
      else lo = mid + 1;
    }
    const best = probeMinutes(hi);
    if (!best) return null;
    return suggestionOf(best, best.totalWalkMeters, best.totalWalkMinutes);
  }

  const probe = (limit: number | null) => {
    const solve = solveJoint(facts, toPartyConditions("A", { ...constraints, maxWalkMeters: limit }), null, now);
    if (!solve.best || solve.extraLegsNeeded > 0) return null;
    if (solve.best.stops.length < SOLO_MIN_STOPS) return null;
    return solve.best;
  };
  // 先试「完全不设上限」：如果连它都不行，说明问题不在上限
  const relaxed = probe(null);
  if (relaxed) {
    return suggestionOf(relaxed, relaxed.totalWalkMeters, relaxed.totalWalkMinutes);
  }
  const candidates = facts.pool
    .map((item) => facts.legs[`${FACT_START_KEY}->${item.id}`]?.leg.distanceMeters)
    .filter((value): value is number => typeof value === "number");
  for (const meters of [...new Set(candidates)].sort((a, b) => a - b)) {
    const best = probe(meters);
    if (best) {
      return suggestionOf(best, Math.max(meters, best.totalWalkMeters), best.totalWalkMinutes);
    }
  }
  return null;
}

export function solveSolo(
  rawFacts: FactSet,
  constraints: SoloConstraints,
  now: Date = new Date(),
): SoloSolve {
  // 每站停留时长只在这一次求解里生效：下面所有求解（含反事实对照、建议值）都用同一份拷贝
  const facts = withStayMinutes(rawFacts, constraints.stayMinutes);
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
      const suggestion = hasWalkCap(constraints) ? suggestLimit(facts, constraints, now) : null;
      const reason = suggestion ? `${solve.note}${suggestionSentence(constraints, suggestion)}` : solve.note;
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
    const suggestion = hasWalkCap(constraints) ? suggestLimit(facts, constraints, now) : null;
    const reason = suggestion ? `${solve.note}${suggestionSentence(constraints, suggestion)}` : solve.note;
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
    const minutesCap = constraints.maxWalkMinutes ?? null;
    if (minutesCap !== null) {
      const minutesRelaxed = solveJoint(facts, toPartyConditions("A", { ...constraints, maxWalkMinutes: null }), null, now);
      if (minutesRelaxed.best && minutesRelaxed.best.stops.length > solve.best.stops.length) {
        causes.push(`取消步行时间上限后能排到 ${minutesRelaxed.best.stops.length} 站，说明是「全程步行最多 ${minutesCap} 分钟」把站点压掉了`);
      }
    }
    const stay = stayOf(facts);
    if (stay > SHORTEST_STAY_MINUTES) {
      const shorter = solveJoint(withStayMinutes(facts, SHORTEST_STAY_MINUTES), party, null, now);
      if (shorter.best && shorter.best.stops.length > solve.best.stops.length) {
        causes.push(`每站停留改成 ${SHORTEST_STAY_MINUTES} 分钟能排到 ${shorter.best.stops.length} 站，说明是「每站停留 ${stay} 分钟」把站点压掉了`);
      }
    }

    // 步行上限把站数压到不够时，同样要告诉用户「至少放宽到多少才排得出」，否则只知道不行、不知道改多少。
    // suggestLimit 每一步都是真实求解（其余条件原样保留），所以只有「放宽步行上限确实能排出」时才会有值。
    const suggestion = hasWalkCap(constraints) ? suggestLimit(facts, constraints, now) : null;
    const reason =
      `按当前条件最多只能排 ${solve.best.stops.length} 个站（${solve.best.stops.map((s) => s.name).join("、")}），` +
      `少于半日游最少需要的 ${SOLO_MIN_STOPS} 站。` +
      (causes.length ? `${causes.join("；")}。` : "") +
      (safeBest ? ` 不做这些限制时，可以排 ${safeBest.stops.length} 站、全程 ${safeBest.totalWalkMeters} 米。` : "") +
      (suggestion ? suggestionSentence(constraints, suggestion) : "");
    return { ok: false, kind: "no-solution", reason, suggestion, missingEdges: solve.missingEdges, extraLegsNeeded: solve.extraLegsNeeded, unmet: solve.unmet };
  }

  const itinerary = solve.best;
  const limit = constraints.maxWalkMeters;
  const withinLimit = limit === null || itinerary.totalWalkMeters <= limit;
  const limitMinutes = constraints.maxWalkMinutes ?? null;
  const withinMinutesLimit = limitMinutes === null || itinerary.totalWalkMinutes <= limitMinutes;
  const longestSegment = longestSegmentMeters(itinerary);
  const segmentLimit = constraints.maxSegmentMeters;
  const withinSegmentLimit = segmentLimit === null || longestSegment <= segmentLimit;

  // 反事实：不设步行上限（米与分钟都取消）会排成什么样（纯本地枚举，0 调用）
  const relaxedWalk = limit !== null || limitMinutes !== null
    ? solveJoint(facts, toPartyConditions("A", { ...constraints, maxWalkMeters: null, maxWalkMinutes: null }), null, now)
    : null;
  let withoutLimit: SoloExplanation["withoutLimit"] = null;
  if (relaxedWalk?.best) {
    withoutLimit = {
      totalWalkMeters: relaxedWalk.best.totalWalkMeters,
      totalWalkMinutes: relaxedWalk.best.totalWalkMinutes,
      stopCount: relaxedWalk.best.stops.length,
    };
  }

  const kept = new Set(itinerary.stops.map((stop) => stop.flyaiId));
  const whyDropped: DroppedStop[] = [];

  // 上限删站：把「没设上限时出现、设了上限后消失」的站逐个说明
  if (withoutLimit && withoutLimit.stopCount > itinerary.stops.length) {
    // 只按分钟设限时用分钟说话（用户定的口径）；设了米数就沿用米数
    const byMinutes = limit === null && limitMinutes !== null;
    for (const stop of relaxedWalk?.best?.stops ?? []) {
      if (kept.has(stop.flyaiId)) continue;
      whyDropped.push({
        id: stop.flyaiId,
        name: stop.name,
        text: byMinutes
          ? `保留「${stop.name}」全程要步行约 ${withoutLimit.totalWalkMinutes} 分钟，超出你定的 ${limitMinutes} 分钟，所以这次没排它。`
          : `保留「${stop.name}」全程会走到 ${withoutLimit.totalWalkMeters} 米，超出你定的 ${limit} 米，所以这次没排它。`,
      });
    }
  }

  const keptBecauseMust: string[] = [];
  for (const id of constraints.mustVisit) {
    const stop = itinerary.stops.find((item) => item.flyaiId === id);
    if (stop) keptBecauseMust.push(stop.name);
  }

  /*
   * 停留时长压站：同样的条件、只把每站停留换成最短一档再解一次。站数变多，才说是停留压掉的；
   * 站数不变（比如是步行上限卡住的），就不说，避免把原因记到错的那条条件上。
   */
  const stay = stayOf(facts);
  let stayNote: string | null = null;
  if (stay > SHORTEST_STAY_MINUTES) {
    const shorter = solveJoint(withStayMinutes(facts, SHORTEST_STAY_MINUTES), party, null, now);
    if (shorter.best && shorter.best.stops.length > itinerary.stops.length) {
      stayNote = `每站停留 ${stay} 分钟时，半日 ${itinerary.budgetMinutes} 分钟里最多排 ${itinerary.stops.length} 站；每站停 ${SHORTEST_STAY_MINUTES} 分钟可以排 ${shorter.best.stops.length} 站。`;
    }
  }

  return {
    ok: true,
    solve,
    explanation: {
      totalWalkMeters: itinerary.totalWalkMeters,
      totalWalkMinutes: itinerary.totalWalkMinutes,
      limit,
      limitMinutes,
      withinMinutesLimit,
      withinLimit,
      longestSegmentMeters: longestSegment,
      segmentLimit,
      withinSegmentLimit,
      verdict: verdictText({
        totalWalkMeters: itinerary.totalWalkMeters,
        totalWalkMinutes: itinerary.totalWalkMinutes,
        limit,
        limitMinutes,
        longestSegmentMeters: longestSegment,
        segmentLimit,
      }),
      whyDropped,
      keptBecauseMust,
      withoutLimit,
      stayMinutes: stay,
      stayNote,
    },
  };
}
