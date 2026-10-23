import type { VerifiedStop, WalkingLeg } from "@/lib/types";
import { haversineMeters } from "../geo.ts";
import { HANGZHOU_TIME_LABEL } from "../hangzhou-time.ts";
import {
  BUFFER_MINUTES,
  BUDGET_MINUTES,
  MATCH_STATUS_LABELS,
  OPENING_STATUS_LABELS,
  assumedTripWindow,
} from "../verification.ts";
import { composeItinerary, legKey } from "../itinerary-compose.ts";
import {
  COST_SCOPE_NOTICE,
  FACT_START_KEY,
  type ConditionHit,
  type FactSet,
  type FactStop,
  type JointSolve,
  type MissingEdge,
  type PartyConditions,
  type StopDisposition,
} from "./types.ts";

/** 双人模式允许 1~2 站；单人流程的 MIN_STOPS 与目标函数不受这里影响。 */
export const JOINT_MIN_STOPS = 1;
export const JOINT_MAX_STOPS = 4;

interface Candidate {
  ids: string[];
  legs: WalkingLeg[];
  walkMeters: number;
  walkMinutes: number;
  totalMinutes: number;
  satA: number;
  satB: number;
  /** 被舍弃的「特别想去」里离起点最远的距离，用来做确定性 tie-break */
  droppedFurthest: number;
  biasScore: number;
}

function stopById(facts: FactSet, id: string): FactStop | undefined {
  return facts.pool.find((item) => item.id === id);
}

function displayName(facts: FactSet, id: string): string {
  return id === FACT_START_KEY ? facts.start.name : stopById(facts, id)?.name ?? id;
}

function toStop(facts: FactSet, id: string): VerifiedStop {
  const stop = stopById(facts, id);
  if (!stop) throw new Error(`事实集里缺少站点 ${id}`);
  return {
    name: stop.name,
    flyaiId: stop.id,
    amapId: stop.amapId ?? "",
    address: stop.address ?? null,
    position: stop.position,
    matchStatus: stop.matchStatus,
    stayMinutes: stop.stayMinutes,
    staySource: "simulated",
    openingStatus: stop.openingStatus,
    openingNote: stop.openingNote,
    jumpUrl: stop.jumpUrl ?? null,
    flyaiDescription: stop.flyaiDescription ?? null,
  };
}

function permutations(items: string[], size: number): string[][] {
  const output: string[][] = [];
  const walk = (picked: string[], rest: string[]) => {
    if (picked.length === size) {
      output.push([...picked]);
      return;
    }
    for (let index = 0; index < rest.length; index += 1) {
      walk([...picked, rest[index]], [...rest.slice(0, index), ...rest.slice(index + 1)]);
    }
  };
  walk([], items);
  return output;
}

function preferSatisfied(party: PartyConditions, ids: string[]): number {
  return ids.filter((id) => party.soft[id] === "prefer").length;
}

function hasPrefer(party: PartyConditions): boolean {
  return Object.values(party.soft).some((rank) => rank === "prefer");
}

function biasScoreOf(party: PartyConditions, candidate: { ids: string[]; walkMeters: number }): number {
  if (party.bias === "see_more") return candidate.ids.length;
  if (party.bias === "walk_less") return -Math.round(candidate.walkMeters / 1000);
  return 0;
}

/** 本方没提时间上限时用产品窗口兜底，双人模式不因「没人说」而默许无限延后。 */
function endLimitOf(party: PartyConditions, startMinutes: number): number {
  return party.hard.latestEndMinutes ?? startMinutes + BUDGET_MINUTES;
}

/** 界面上唯一的步行距离口径：协商面板、差异卡与喂给智能体的事实块都用它。 */
export function metersText(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} 公里` : `${value} 米`;
}

function minutesOfDay(total: number): string {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function rankCandidates(): (x: Candidate, y: Candidate) => number {
  return (x, y) => {
    // 1. 双方重要软偏好的平衡：先让「满足较少的一方」尽量多
    const minBalance = Math.min(y.satA, y.satB) - Math.min(x.satA, x.satB);
    if (minBalance !== 0) return minBalance;
    // 2. 再比双方总计：一方偏好根本无法满足时，不能为了「差距为零」把另一方的也扔掉
    const total = (y.satA + y.satB) - (x.satA + x.satB);
    if (total !== 0) return total;
    // 3. 同样平衡时，优先保住离起点更近的那条强偏好（= 被舍弃的那条更远，所以取降序），
    //    再按双方「多看几个 / 少走路」的倾向计分
    const dropped = y.droppedFurthest - x.droppedFurthest;
    if (dropped !== 0) return dropped;
    const bias = y.biasScore - x.biasScore;
    if (bias !== 0) return bias;
    // 4. 最后才是站数、步行距离、总耗时
    if (y.ids.length !== x.ids.length) return y.ids.length - x.ids.length;
    if (x.walkMeters !== y.walkMeters) return x.walkMeters - y.walkMeters;
    return x.totalMinutes - y.totalMinutes;
  };
}

export function solveJoint(
  facts: FactSet,
  a: PartyConditions,
  b: PartyConditions | null,
  tripDate: Date,
): JointSolve {
  const parties: PartyConditions[] = b ? [a, b] : [a];
  // 调用方可能传入真实当前时刻；仍按该上海日期的 13:00 出发，不能把
  // 正确的 UTC instant 再用服务器 getHours() 误读为用户的出发分钟。
  const { startAt: assumedStart, startMinutes } = assumedTripWindow(tripDate);

  const missing = new Map<string, MissingEdge>();
  const rememberMissing = (fromId: string, toId: string) => {
    const key = legKey(fromId, toId);
    if (facts.legs[key] || missing.has(key)) return;
    // 高德明确拒绝过的段是「有证据的排除」，不能当成「再补测一次就行」
    if (facts.failedPairs.includes(key)) return;
    missing.set(key, { key, name: `${displayName(facts, fromId)} → ${displayName(facts, toId)}` });
  };

  const base = (over: Partial<JointSolve>): JointSolve => ({
    kind: "found",
    best: null,
    runnersUp: [],
    hardConflict: null,
    missingEdges: [],
    extraLegsNeeded: 0,
    satisfied: [],
    unmet: [],
    dispositions: [],
    unverified: [],
    note: COST_SCOPE_NOTICE,
    ...over,
  });

  /* 条件本身不可用：站不在已核验全集、或同一方自相矛盾。不替用户猜，也不丢掉某一方的要求。 */
  const knownIds = new Set(facts.pool.map((item) => item.id));
  const invalid: ConditionHit[] = [];
  for (const party of parties) {
    const mentioned = [...party.hard.mustVisit, ...party.hard.neverAccept, ...Object.keys(party.soft)];
    for (const id of mentioned) {
      if (!knownIds.has(id)) {
        invalid.push({ role: party.role, kind: "hard", text: `「${id}」不在已核验候选全集里，无法核实身份，不能作为条件接受` });
      }
    }
    for (const id of party.hard.mustVisit.filter((item) => party.hard.neverAccept.includes(item))) {
      invalid.push({ role: party.role, kind: "hard", text: `本方把「${displayName(facts, id)}」同时列为必须去和绝不接受` });
    }
  }
  if (invalid.length) {
    return base({ kind: "constraint-invalid", unmet: invalid });
  }

  const neverIds = new Set(parties.flatMap((party) => party.hard.neverAccept));
  const mustAll = [...new Set(parties.flatMap((party) => party.hard.mustVisit))];

  /* 一方的必须去撞上另一方的绝不接受：这是真正的硬冲突，双方都要重新表态。 */
  const clash = mustAll.filter((id) => neverIds.has(id));
  if (clash.length) {
    const evidence = clash.map((id) => {
      const owner = parties.filter((p) => p.hard.mustVisit.includes(id)).map((p) => p.role);
      const block = parties.filter((p) => p.hard.neverAccept.includes(id)).map((p) => p.role);
      return `「${displayName(facts, id)}」是 ${owner.join("、")} 的必须去，同时是 ${block.join("、")} 的绝不接受`;
    });
    return base({
      kind: "hard-conflict",
      hardConflict: { byRole: "both", constraint: "必须去与绝不接受撞在同一站", evidence },
    });
  }

  const universe = facts.pool.filter((item) => !neverIds.has(item.id)).map((item) => item.id);
  const tightestCap = Math.min(...parties.map((p) => p.hard.maxWalkMeters ?? Number.POSITIVE_INFINITY));
  /** 报价口径只有一处真相：与状态机用的是同一个函数，避免两个数字打架 */
  const quoteFor = (targets: string[]) => estimateMissingEdges(facts, [...new Set(targets)], { universe });

  const collect = (applyHard: boolean): Candidate[] => {
    const out: Candidate[] = [];
    for (let size = JOINT_MAX_STOPS; size >= JOINT_MIN_STOPS; size -= 1) {
      for (const ids of permutations(universe, size)) {
        if (!mustAll.every((id) => ids.includes(id))) continue;

        const legs: WalkingLeg[] = [];
        let walkMeters = 0;
        let walkMinutes = 0;
        let previous = FACT_START_KEY;
        let usable = true;
        for (const id of ids) {
          const entry = facts.legs[legKey(previous, id)];
          if (!entry) {
            usable = false;
            // 已经超出最严上限的链条，补测这条路也救不回来，不计入报价
            if (!applyHard || walkMeters <= tightestCap) rememberMissing(previous, id);
            break;
          }
          legs.push(entry.leg);
          walkMeters += entry.leg.distanceMeters;
          walkMinutes += entry.leg.durationMinutes;
          previous = id;
        }
        if (!usable) continue;

        const stayMinutes = ids.reduce((sum, id) => sum + (stopById(facts, id)?.stayMinutes ?? 0), 0);
        const totalMinutes = walkMinutes + stayMinutes + BUFFER_MINUTES;

        if (applyHard) {
          if (parties.some((p) => p.hard.maxWalkMeters !== null && walkMeters > p.hard.maxWalkMeters)) continue;
          if (parties.some((p) => startMinutes + totalMinutes > endLimitOf(p, startMinutes))) continue;
        }

        const droppedPrefer = parties
          .flatMap((p) => Object.keys(p.soft).filter((id) => p.soft[id] === "prefer" && !ids.includes(id)))
          .map((id) => stopById(facts, id)?.straightLineMeters ?? 0);

        const shape = { ids, walkMeters };
        out.push({
          ids,
          legs,
          walkMeters,
          walkMinutes,
          totalMinutes,
          satA: preferSatisfied(a, ids),
          satB: b ? preferSatisfied(b, ids) : 0,
          droppedFurthest: droppedPrefer.length ? Math.max(...droppedPrefer) : 0,
          biasScore: biasScoreOf(a, shape) + (b ? biasScoreOf(b, shape) : 0),
        });
      }
    }
    return out;
  };

  const feasible = collect(true);

  if (!feasible.length) {
    /* 放宽硬上限再搜一次：只有「相关段全部实测或按补测策略可补齐」才允许下「已证实不可行」的结论。 */
    const relaxed = collect(false);
    const allPrefer = parties.flatMap((party) => Object.keys(party.soft).filter((id) => party.soft[id] === "prefer"));
    const quote = quoteFor([...mustAll, ...allPrefer]);
    if (quote.length) {
      const listed = quote;
      return base({
        kind: "not-measured",
        missingEdges: listed,
        extraLegsNeeded: listed.length,
        dispositions: facts.pool
          .filter((item) => mustAll.includes(item.id) || allPrefer.includes(item.id))
          .map((item) => ({
            id: item.id,
            name: item.name,
            status: "not-measured" as const,
            text: `与已实测的站之间缺少步行段，尚未核验——是「没测到」，不是「不去」，也不是「走不到」`,
          })),
        unmet: parties.flatMap((p) =>
          p.hard.mustVisit
            .filter((id) => !feasible.some((c) => c.ids.includes(id)))
            .map((id) => ({ role: p.role, kind: "hard" as const, text: `「${displayName(facts, id)}」需要补测步行段才能判断能否入方案，目前没有实测依据` })),
        ),
        note: `有 ${listed.length} 条有向步行段从未实测：${listed.map((e) => e.name).join("、")}。` +
          `这里不会把「没测到」说成「走不到」，也不会为了凑方案放宽任何一方的硬约束。${COST_SCOPE_NOTICE}`,
      });
    }
    /** 超出补测策略（每站只测直线最近 4 邻）而没有实测依据的组合数量，必须如实说明 */
    const outOfPolicy = missing.size;
    if (!relaxed.length) {
      return base({
        kind: "hard-conflict",
        hardConflict: {
          byRole: "both",
          constraint: "已实测的段不足以组成含「必须去」的链条",
          evidence: [`在已实测的 ${Object.keys(facts.legs).length} 段里，找不到任何一条能把「${mustAll.map((id) => displayName(facts, id)).join("、")}」串起来的链条。`],
        },
        note: `已实测的段不足以组成任何含「必须去」的链条${outOfPolicy ? `；另有 ${outOfPolicy} 种走法因超出补测策略（每站只测直线最近的 4 邻）没有实测依据` : ""}。${COST_SCOPE_NOTICE}`,
      });
    }
    const leastWalk = [...relaxed].sort((x, y) => x.walkMeters - y.walkMeters)[0];
    const soonest = [...relaxed].sort((x, y) => x.totalMinutes - y.totalMinutes)[0];
    const mustNames = mustAll.map((id) => displayName(facts, id)).join("、") || "可行组合";
    const blocked: ConditionHit[] = [];
    for (const party of parties) {
      const cap = party.hard.maxWalkMeters;
      if (cap !== null && leastWalk.walkMeters > cap) {
        blocked.push({
          role: party.role,
          kind: "hard",
          text: `含「${mustNames}」的全部实测组合里，步行最短的一条是 ${metersText(leastWalk.walkMeters)}，比本方上限 ${metersText(cap)} 多 ${metersText(leastWalk.walkMeters - cap)}`,
        });
      }
      const limit = endLimitOf(party, startMinutes);
      if (startMinutes + soonest.totalMinutes > limit) {
        blocked.push({
          role: party.role,
          kind: "hard",
          text: `最快结束的一轮也要到 ${minutesOfDay(startMinutes + soonest.totalMinutes)}，晚于本方上限 ${minutesOfDay(limit)}（${HANGZHOU_TIME_LABEL}）`,
        });
      }
    }
    if (!blocked.length) {
      return base({
        kind: "not-measured",
        note: `放宽上限后仍有 ${relaxed.length} 个组合，但没有任何一方的数字上限被违反，说明搜索空间本身缺实测段。${COST_SCOPE_NOTICE}`,
      });
    }
    return base({
      kind: "hard-conflict",
      hardConflict: {
        byRole: new Set(blocked.map((item) => item.role)).size === 1 ? blocked[0].role : "both",
        constraint: [...new Set(blocked.map((item) => `${item.role} 的硬约束`))].join(" 与 "),
        evidence: blocked.map((item) => item.text),
      },
      unmet: blocked,
      note: `已证实不可行：${blocked.map((item) => `[${item.role}] ${item.text}`).join("；")}。` +
        (outOfPolicy ? `另有 ${outOfPolicy} 种走法因超出补测策略（每站只测直线最近的 4 邻）没有实测依据，不在上述结论范围内。` : "") +
        `这里不放宽任何一方的硬条件，也不编造数据。${COST_SCOPE_NOTICE}`,
    });
  }

  const best = [...feasible].sort(rankCandidates())[0];
  const shortestPossible = Math.min(...feasible.map((c) => c.walkMeters));

  const itinerary = composeItinerary(
    facts.start,
    best.ids.map((id) => toStop(facts, id)),
    best.legs,
    assumedStart,
  );
  const runnersUp = [...feasible]
    .slice(1, 3)
    .map((c) => composeItinerary(facts.start, c.ids.map((id) => toStop(facts, id)), c.legs, assumedStart));

  /* 一方的「特别想去」全落空、另一方有命中：出方案，但必须标成需要双方再谈。 */
  const zeroParty = parties.find((p) => hasPrefer(p) && preferSatisfied(p, best.ids) === 0);
  const otherHit = parties.some((p) => preferSatisfied(p, best.ids) > 0);
  const kind = zeroParty && otherHit ? "soft-imbalanced" : "found";

  const satisfied: ConditionHit[] = [];
  const unmet: ConditionHit[] = [];
  for (const party of parties) {
    const cap = party.hard.maxWalkMeters;
    if (cap !== null) {
      satisfied.push({ role: party.role, kind: "hard", text: `总步行 ${metersText(best.walkMeters)} ≤ 本方上限 ${metersText(cap)}` });
    }
    if (party.hard.latestEndMinutes !== null) {
      satisfied.push({
        role: party.role,
        kind: "hard",
        text: `预计 ${minutesOfDay(startMinutes + best.totalMinutes)} 结束，不晚于本方上限 ${minutesOfDay(party.hard.latestEndMinutes)}（${HANGZHOU_TIME_LABEL}）`,
      });
    }
    for (const id of party.hard.mustVisit) {
      satisfied.push({ role: party.role, kind: "hard", text: `「${displayName(facts, id)}」已进入方案` });
    }
    for (const id of party.hard.neverAccept) {
      satisfied.push({ role: party.role, kind: "hard", text: `「${displayName(facts, id)}」未出现在方案中` });
    }
    for (const [id, rank] of Object.entries(party.soft)) {
      const name = displayName(facts, id);
      if (rank === "prefer") {
        (best.ids.includes(id) ? satisfied : unmet).push({
          role: party.role,
          kind: "soft",
          text: best.ids.includes(id) ? `本方特别想去「${name}」已排入` : `本方特别想去「${name}」未排入（不是绝不接受，可以再谈）`,
        });
      } else if (rank === "avoid") {
        (best.ids.includes(id) ? unmet : satisfied).push({
          role: party.role,
          kind: "soft",
          text: best.ids.includes(id) ? `本方不太想去「${name}」仍被排入（不太想去不等于绝不接受）` : `本方不太想去「${name}」未排入`,
        });
      }
      // follow 不记分也不记落空：愿意跟随不等于放弃个人硬约束，也不等于支持对方偏好
    }
    if (party.bias === "walk_less") {
      (best.walkMeters === shortestPossible ? satisfied : unmet).push({
        role: party.role,
        kind: "soft",
        text: best.walkMeters === shortestPossible
          ? `本方偏少走路：已取当前可行组合里步行最短的一条（${metersText(best.walkMeters)}）`
          : `本方偏少走路：为兼顾对方的「多看几个」，本方案比最短可行组合多走 ${metersText(best.walkMeters - shortestPossible)}`,
      });
    }
    if (party.bias === "see_more") {
      satisfied.push({ role: party.role, kind: "soft", text: `本方想多看几个：本方案 ${best.ids.length} 站` });
    }
  }

  const chosen = new Set(best.ids);
  const dispositions: StopDisposition[] = facts.pool.map((item) => {
    if (neverIds.has(item.id)) {
      const roles = parties.filter((p) => p.hard.neverAccept.includes(item.id)).map((p) => p.role);
      return { id: item.id, name: item.name, status: "rejected-never", text: `${roles.join("、")} 标为绝不接受，已排除` };
    }
    if (chosen.has(item.id)) return { id: item.id, name: item.name, status: "selected", text: "已进入当前方案" };
    // 已有含该站的可行组合，就不能把它写成「缺连接、尚未核验」。
    if (feasible.some((candidate) => candidate.ids.includes(item.id))) {
      return {
        id: item.id, name: item.name, status: "dropped-soft",
        text: `有含该站的已实测可行走法，但本版按双方条件与偏好取 ${best.ids.length} 站、${metersText(best.walkMeters)}，未选用该站`,
      };
    }
    // 只说明与当前路线相关的缺边，不要求自环，也不把其它未入选站的缺边当作本版原因。
    // 两个方向独立核查；反向已测不能证明正向已测。高德明确失败的段不算「没测过」。
    const connectionKeys = [
      legKey(FACT_START_KEY, item.id),
      ...best.ids.flatMap((other) => [legKey(other, item.id), legKey(item.id, other)]),
    ];
    const missingConnections = connectionKeys.filter((key) => !facts.legs[key] && !facts.failedPairs.includes(key));
    if (missingConnections.length) {
      const names = missingConnections.map((key) => {
        const [fromId, toId] = key.split("->");
        return `${displayName(facts, fromId)} → ${displayName(facts, toId)}`;
      });
      return {
        id: item.id, name: item.name, status: "not-measured",
        text: `与当前路线相关的有向步行段尚未实测：${names.join("、")}；含该站的走法仍需核验（不是「不去」，也不代表没有任何连接）`,
      };
    }
    if (parties.some((p) => p.hard.mustVisit.includes(item.id))) {
      return { id: item.id, name: item.name, status: "rejected-hard", text: "必须去却未排入——已按硬约束拒绝该组合" };
    }
    return {
      id: item.id,
      name: item.name,
      status: "rejected-hard",
      text: "已实测组合中未找到满足当前双方条件的含该站走法，未入选；未测组合不作可行性判断",
    };
  });

  const unverified: string[] = [];
  for (const stop of itinerary.stops) {
    if (stop.matchStatus !== "matched") unverified.push(`${stop.name}：${MATCH_STATUS_LABELS[stop.matchStatus]}`);
    if (stop.openingStatus === "unknown" || stop.openingStatus === "conflict") {
      unverified.push(`${stop.name}：开放时间${OPENING_STATUS_LABELS[stop.openingStatus]}`);
    }
  }

  const unplacedPrefer = parties.flatMap((party) =>
    Object.keys(party.soft).filter((id) => party.soft[id] === "prefer" && !best.ids.includes(id)),
  );
  const quote = quoteFor([...mustAll, ...unplacedPrefer]);
  const truncated = quote.length
    ? `本方案只是已实测范围内的最优：另有 ${quote.length} 条有向段从未实测（${quote.map((edge) => edge.name).join("、")}），更长或更优的组合还无法判断。`
    : "";

  return base({
    kind,
    best: itinerary,
    runnersUp,
    satisfied,
    unmet,
    dispositions,
    unverified,
    missingEdges: quote,
    extraLegsNeeded: quote.length,
    note: `${truncated}${kind === "soft-imbalanced"
      ? `方案可行，但 ${zeroParty!.role} 特别想去的站点一个都没落进当前组合——需要双方协商（软偏好，不是硬约束冲突）。${COST_SCOPE_NOTICE}`
      : COST_SCOPE_NOTICE}`,
  });
}

/**
 * 补测报价：返回**去重后的实际缺边**。
 * 已实测的段、命中缓存的段、高德已明确拒绝的段都不计入，所以它一定 ≤「每站 9 段」的上界，
 * 状态机必须在花钱之前先用它做预算检查。
 * 邻接策略与 9 段上界同源：起点→新站 1 段 + 新站↔直线最近的 4 个既有站双向 ≤8 段。
 */
export function estimateMissingEdges(
  facts: FactSet,
  targetIds: string[],
  options: { universe?: string[]; bothDirections?: boolean; nearestNeighbors?: number } = {},
): MissingEdge[] {
  const neighborLimit = options.nearestNeighbors ?? 4;
  const partners = options.universe ?? facts.pool.map((item) => item.id);
  const out: MissingEdge[] = [];
  const seen = new Set<string>();
  const push = (fromId: string, toId: string) => {
    const key = legKey(fromId, toId);
    if (seen.has(key) || facts.legs[key] || facts.failedPairs.includes(key)) return;
    seen.add(key);
    out.push({ key, name: `${displayName(facts, fromId)} → ${displayName(facts, toId)}` });
  };
  for (const id of targetIds) {
    const stop = stopById(facts, id);
    if (!stop) continue;
    push(FACT_START_KEY, id);
    const nearest = partners
      .filter((other) => other !== id)
      .map((other) => stopById(facts, other))
      .filter((other): other is FactStop => Boolean(other))
      .map((other) => ({ id: other.id, meters: haversineMeters(stop.position, other.position) }))
      .sort((x, y) => x.meters - y.meters)
      .slice(0, neighborLimit);
    for (const neighbor of nearest) {
      push(neighbor.id, id);
      if (options.bothDirections !== false) push(id, neighbor.id);
    }
  }
  return out;
}
