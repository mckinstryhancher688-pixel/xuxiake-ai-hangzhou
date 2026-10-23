import type { WalkingLeg } from "@/lib/types";
import {
  BUFFER_MINUTES,
  BUDGET_MINUTES,
  MAX_STOPS,
  MIN_STOPS,
  SIMULATED_STAY_MINUTES,
} from "./verification.ts";

interface ChainItem {
  match: { flyaiId: string };
}

export interface VerifiedChain<T> {
  items: T[];
  legs: WalkingLeg[];
  totalMinutes: number;
}

export interface VerifiedChainAnalysis<T> {
  best: VerifiedChain<T> | null;
  /** 具有全部有向实测段的有序组合数，包含超过预算的组合。 */
  completeCount: number;
  /** 至少缺一段可用有向实测段的有序组合数，不能据此判定超时。 */
  missingLegCount: number;
  /** 所有完整组合的最短总时长；包含模拟停留与余量，非 API 请求耗时。 */
  minCompleteMinutes: number | null;
}

/**
 * 只分析已经测出的有向路段，不调用任何外部服务。
 * 与原单人选路规则相同：优先 4 站，再比较同站数的总时长；完全同分保留原枚举顺序。
 * 无解时仍统计完整组合和缺段组合，避免把「缺少实测依据」误报为「全部超过预算」。
 */
export function analyzeVerifiedChains<T extends ChainItem>(
  pool: readonly T[],
  pairLegs: ReadonlyMap<string, WalkingLeg>,
): VerifiedChainAnalysis<T> {
  const analysis: VerifiedChainAnalysis<T> = {
    best: null,
    completeCount: 0,
    missingLegCount: 0,
    minCompleteMinutes: null,
  };

  for (let size = MAX_STOPS; size >= MIN_STOPS; size -= 1) {
    for (const combo of permutations(pool, size)) {
      const legs: WalkingLeg[] = [];
      let walkMinutes = 0;
      let previous = "__start__";
      let complete = true;
      for (const item of combo) {
        const leg = pairLegs.get(`${previous}->${item.match.flyaiId}`);
        if (!leg) {
          complete = false;
          break;
        }
        legs.push(leg);
        walkMinutes += leg.durationMinutes;
        previous = item.match.flyaiId;
      }

      if (!complete) {
        analysis.missingLegCount += 1;
        continue;
      }

      analysis.completeCount += 1;
      const totalMinutes = walkMinutes + combo.length * SIMULATED_STAY_MINUTES + BUFFER_MINUTES;
      analysis.minCompleteMinutes =
        analysis.minCompleteMinutes === null
          ? totalMinutes
          : Math.min(analysis.minCompleteMinutes, totalMinutes);
      if (totalMinutes > BUDGET_MINUTES) continue;

      const best = analysis.best;
      if (
        !best ||
        combo.length > best.items.length ||
        (combo.length === best.items.length && totalMinutes < best.totalMinutes)
      ) {
        analysis.best = { items: combo, legs, totalMinutes };
      }
    }
  }
  return analysis;
}

/** 仅用于 best 为 null 的分析结果；不将缺段组合描述为已确认超时。 */
export function describeVerifiedChainFailure(
  analysis: VerifiedChainAnalysis<unknown>,
  candidateCount: number,
): string {
  const range = `${MIN_STOPS}~${MAX_STOPS} 站`;
  if (analysis.completeCount === 0) {
    return `${candidateCount} 个已核验地点的 ${analysis.missingLegCount} 种 ${range}有序组合均缺少至少一段可用的高德实测有向路段，暂时无法组成完整路线。不会用估算步行时间或反向路段补齐缺段。`;
  }

  const measured = `${analysis.completeCount} 种具备完整实测路段的 ${range}有序组合均超过 ${BUDGET_MINUTES} 分钟预算，最短也需要 ${analysis.minCompleteMinutes} 分钟（含模拟停留 ${SIMULATED_STAY_MINUTES} 分钟/站与 ${BUFFER_MINUTES} 分钟余量）`;
  const missing = analysis.missingLegCount
    ? `；另有 ${analysis.missingLegCount} 种组合缺少可用的实测有向路段，尚无法判断是否满足预算`
    : "";
  return `${candidateCount} 个已核验地点中，${measured}${missing}。这里不会缩短真实步行时间来凑数。`;
}

function permutations<T>(items: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  const walk = (picked: T[], remaining: readonly T[]) => {
    if (picked.length === size) {
      output.push([...picked]);
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      walk([...picked, remaining[index]], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
    }
  };
  walk([], items);
  return output;
}
