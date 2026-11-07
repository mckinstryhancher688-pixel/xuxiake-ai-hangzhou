import type { CandidateMatch, DiscoveredPoi, VerifiedItinerary, VerifiedStop } from "./types";

/**
 * 来源证据层（飞猪优化① B1）：行程里每一站的飞猪 id 与原始链接，
 * 必须能在本次飞猪返回的候选集合里找到；找不到就标「未校验」，绝不静默放行。
 * 纯函数、无外部依赖，服务端装配与前端展示共用同一套判定。
 */

/** 飞猪缺 id 时 discover 会补占位标识；只有原样返回的 id 才算来源可校验。 */
export function flyaiIdFromSourceOf(poi: Pick<DiscoveredPoi, "missingFields">): boolean {
  return !poi.missingFields.includes("id");
}

export interface SourceAuditResult {
  itinerary: VerifiedItinerary;
  /** 被标为未校验的站点名；构造链路正常时应为空，非空说明有站点对不上本次候选集合 */
  flagged: string[];
}

/**
 * 逐站核对 flyaiId 与 jumpUrl 是否和本次候选记录一致。
 * 对不上的站保留在行程里但强制 flyaiIdFromSource=false（界面点亮不了 ✓），
 * 不悄悄删站——删站会改变已经付费实测的路段链条。
 */
export function auditStopSources(
  itinerary: VerifiedItinerary,
  matches: Pick<CandidateMatch, "flyaiId" | "jumpUrl">[],
): SourceAuditResult {
  const byId = new Map(matches.map((match) => [match.flyaiId, match]));
  const flagged: string[] = [];
  const stops = itinerary.stops.map((stop) => {
    const source = byId.get(stop.flyaiId);
    if (source && source.jumpUrl === stop.jumpUrl) return stop;
    flagged.push(stop.name);
    return { ...stop, flyaiIdFromSource: false };
  });
  return { itinerary: flagged.length ? { ...itinerary, stops } : itinerary, flagged };
}

export interface SourceEvidence {
  /** ✓已校验 只有 checked 才点亮 */
  state: "checked" | "unchecked";
  /** unchecked 时的具体原因，直接展示 */
  reason: string | null;
  /** 飞猪返回该数据的时间；null = 未记录，界面如实写「查询时间未记录」 */
  collectedAt: string | null;
}

export function sourceEvidenceOf(
  stop: Pick<VerifiedStop, "flyaiIdFromSource" | "flyaiCollectedAt">,
): SourceEvidence {
  const collectedAt = stop.flyaiCollectedAt ?? null;
  if (stop.flyaiIdFromSource === true) return { state: "checked", reason: null, collectedAt };
  return {
    state: "unchecked",
    reason: stop.flyaiIdFromSource === false ? "id 未通过来源校验" : "早期记录未留存来源校验",
    collectedAt,
  };
}