import type { VerifiedItinerary } from "@/lib/types";
import type { LegDelta, NegotiationDiff, SignedNumber } from "./types.ts";

/**
 * 差异一律保留正负号：双人模式下「少走一点」不是单调方向，
 * 删两站也可能因为绕行而更远。钳位会把协商代价藏起来。
 * （单人「少走一点」用的 savingsOf() 保持原样，两边不共用。）
 */
function signed(from: number, to: number): SignedNumber {
  const delta = to - from;
  return { from, to, delta, direction: delta > 0 ? "increase" : delta < 0 ? "decrease" : "same" };
}

function legName(leg: { fromName: string; toName: string }): string {
  return `${leg.fromName} → ${leg.toName}`;
}

function meters(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} 公里` : `${Math.round(value)} 米`;
}

export function diffItineraries(
  from: VerifiedItinerary,
  to: VerifiedItinerary,
  identity: { fromRevision: number; toRevision: number; fromHash: string; toHash: string },
): NegotiationDiff {
  const totalWalkMeters = signed(from.totalWalkMeters, to.totalWalkMeters);
  const totalWalkMinutes = signed(from.totalWalkMinutes, to.totalWalkMinutes);
  const totalMinutes = signed(from.totalMinutes, to.totalMinutes);

  const names = (itinerary: VerifiedItinerary) => itinerary.stops.map((stop) => stop.name);
  const fromNames = names(from);
  const toNames = names(to);

  const legDeltas: LegDelta[] = [];
  const seen = new Set<string>();
  for (const leg of from.legs) {
    const key = `${leg.fromName}->${leg.toName}`;
    const counterpart = to.legs.find((item) => `${item.fromName}->${item.toName}` === key);
    seen.add(key);
    legDeltas.push({
      key,
      name: legName(leg),
      fromMeters: leg.distanceMeters,
      toMeters: counterpart?.distanceMeters ?? null,
      deltaMeters: counterpart ? counterpart.distanceMeters - leg.distanceMeters : null,
    });
  }
  for (const leg of to.legs) {
    const key = `${leg.fromName}->${leg.toName}`;
    if (seen.has(key)) continue;
    const counterpart = from.legs.find((item) => `${item.fromName}->${item.toName}` === key);
    legDeltas.push({
      key,
      name: legName(leg),
      fromMeters: counterpart?.distanceMeters ?? null,
      toMeters: leg.distanceMeters,
      deltaMeters: counterpart ? leg.distanceMeters - counterpart.distanceMeters : null,
    });
  }

  const stopsKept = fromNames.filter((name) => toNames.includes(name));
  const stopsDropped = fromNames.filter((name) => !toNames.includes(name));
  const stopsAdded = toNames.filter((name) => !fromNames.includes(name));
  const orderChanged = toNames
    .map((name, toIndex) => ({ name, fromIndex: fromNames.indexOf(name), toIndex }))
    .filter((item) => item.fromIndex >= 0 && item.fromIndex !== item.toIndex)
    .map((item) => ({ name: item.name, fromIndex: item.fromIndex + 1, toIndex: item.toIndex + 1 }));

  const walkWord = totalWalkMeters.direction === "increase" ? "多走" : totalWalkMeters.direction === "decrease" ? "少走" : "步行不变";
  const timeWord = totalMinutes.direction === "increase" ? "多花" : totalMinutes.direction === "decrease" ? "少花" : "总耗时不变";

  const lines = [
    `v${identity.fromRevision} → v${identity.toRevision}：总步行 ${meters(from.totalWalkMeters)} → ${meters(to.totalWalkMeters)}（${walkWord} ${meters(Math.abs(totalWalkMeters.delta))}，${totalWalkMeters.delta >= 0 ? "+" : "−"}${meters(Math.abs(totalWalkMeters.delta))}）`,
    `步行耗时 ${from.totalWalkMinutes} 分钟 → ${to.totalWalkMinutes} 分钟（${totalWalkMinutes.delta >= 0 ? "+" : "−"}${Math.abs(totalWalkMinutes.delta)} 分钟）；总时长 ${from.totalMinutes} 分钟 → ${to.totalMinutes} 分钟（${timeWord} ${Math.abs(totalMinutes.delta)} 分钟）`,
  ];
  if (stopsKept.length) lines.push(`保留：${stopsKept.join("、")}`);
  if (stopsDropped.length) lines.push(`删掉：${stopsDropped.join("、")}`);
  if (stopsAdded.length) lines.push(`新增：${stopsAdded.join("、")}`);
  for (const item of orderChanged) lines.push(`顺序：${item.name} 从第 ${item.fromIndex} 站到第 ${item.toIndex} 站`);
  for (const leg of legDeltas) {
    if (leg.deltaMeters === null) {
      lines.push(`路段 ${leg.name}：${leg.fromMeters === null ? "本次新增实测" : "本次不再经过"}`);
    } else if (leg.deltaMeters !== 0) {
      lines.push(`路段 ${leg.name}：${leg.fromMeters} 米 → ${leg.toMeters} 米（${leg.deltaMeters > 0 ? "+" : "−"}${Math.abs(leg.deltaMeters)} 米）`);
    }
  }

  return {
    ...identity,
    totalWalkMeters,
    totalWalkMinutes,
    totalMinutes,
    stopsKept,
    stopsDropped,
    stopsAdded,
    orderChanged,
    legDeltas,
    lines,
  };
}
