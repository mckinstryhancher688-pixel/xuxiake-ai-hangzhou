"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { createAdapters, type AdapterMeta } from "@/lib/adapters";
import {
  DATA_DISCLAIMER,
  DEFAULT_ROUTE_ID,
  MOCK_JOURNEY_CONTEXT,
  MOCK_LAKE_OUTLINE,
  MOCK_METRO_STATIONS,
  MOCK_POI_BY_ID,
  MOCK_ROUTE_BY_ID,
  MOCK_STREETS,
} from "@/data/mock";
import type { MapFeature, MapRouteLine } from "@/components/map/types";
import type { ExplorationContent, Poi, RouteVariant } from "@/lib/types";

export type ExplorationStatus = "idle" | "loading" | "ready";

export interface AdapterNote extends AdapterMeta {
  name: string;
}

/** 适配器不读 env、不碰 DOM，模块级创建即可，SSR 与客户端结果一致。 */
const adapters = createAdapters();

const ADAPTER_NOTES: AdapterNote[] = [
  { name: "在场讲解 · 阶段一预写文案", ...adapters.bailian.meta },
  { name: "飞猪 FlyAI", ...adapters.flyai.meta },
  { name: "高德 Web 服务", ...adapters.amap.meta },
];

export function useJourney() {
  const [routeId, setRouteId] = useState<RouteVariant>(DEFAULT_ROUTE_ID);
  const [activePoiId, setActivePoiId] = useState<string>(
    MOCK_ROUTE_BY_ID[DEFAULT_ROUTE_ID].poiIds[0],
  );
  const [visitedIds, setVisitedIds] = useState<string[]>([]);
  const [exploration, setExploration] = useState<ExplorationContent | null>(null);
  const [explorationStatus, setExplorationStatus] = useState<ExplorationStatus>("idle");
  const explorationCache = useRef(new Map<string, ExplorationContent>());

  const route = MOCK_ROUTE_BY_ID[routeId];
  const pois = useMemo<Poi[]>(() => route.poiIds.map((id) => MOCK_POI_BY_ID[id]), [route]);
  const activePoi = MOCK_POI_BY_ID[activePoiId];
  const activeIndex = pois.findIndex((poi) => poi.id === activePoi.id);
  const isActiveVisited = visitedIds.includes(activePoi.id);

  const elapsedMinutes = useMemo(() => {
    const visited = new Set(visitedIds);
    const stay = pois
      .filter((poi) => visited.has(poi.id))
      .reduce((sum, poi) => sum + poi.stayMinutes, 0);
    const walk = route.legs
      .filter((leg) => visited.has(leg.fromId) && visited.has(leg.toId))
      .reduce((sum, leg) => sum + leg.minutes, 0);
    return stay + walk;
  }, [pois, route, visitedIds]);

  const remainingMinutes = Math.max(0, MOCK_JOURNEY_CONTEXT.totalMinutes - elapsedMinutes);

  const selectPoi = useCallback((id: string) => {
    // 地图是可替换组件，回调可能带回非 POI 的 id（如地铁站）
    if (!(id in MOCK_POI_BY_ID)) return;
    setActivePoiId(id);
    const cached = explorationCache.current.get(id);
    setExploration(cached ?? null);
    setExplorationStatus(cached ? "ready" : "idle");
  }, []);

  const markArrived = useCallback(async () => {
    const cached = explorationCache.current.get(activePoi.id);
    setExplorationStatus("loading");

    const content =
      cached ??
      (await adapters.bailian.explore({
        poi: activePoi,
        context: MOCK_JOURNEY_CONTEXT,
        remainingMinutes,
      }));
    explorationCache.current.set(activePoi.id, content);

    setExploration(content);
    setExplorationStatus("ready");
    setVisitedIds((prev) => (prev.includes(activePoi.id) ? prev : [...prev, activePoi.id]));
  }, [activePoi, remainingMinutes]);

  const toggleRoute = useCallback(() => {
    const nextId: RouteVariant = routeId === "standard" ? "short" : "standard";
    const nextRoute = MOCK_ROUTE_BY_ID[nextId];
    setRouteId(nextId);
    setVisitedIds((prev) => prev.filter((id) => nextRoute.poiIds.includes(id)));
    setActivePoiId((prev) => (nextRoute.poiIds.includes(prev) ? prev : nextRoute.poiIds[0]));
    setExploration(null);
    setExplorationStatus("idle");
  }, [routeId]);

  const mapFeatures = useMemo<MapFeature[]>(() => {
    const poiFeatures = pois.map<MapFeature>((poi, index) => ({
      id: poi.id,
      name: poi.name,
      kind: "poi",
      position: poi.position,
      order: index + 1,
      state: visitedIds.includes(poi.id)
        ? "visited"
        : poi.id === activePoi.id
          ? "active"
          : "upcoming",
    }));
    const metroFeatures = MOCK_METRO_STATIONS.map<MapFeature>((station) => ({
      id: `metro-${station.name}`,
      name: `${station.name} · ${station.line}`,
      kind: "metro",
      position: station.position,
      state: "upcoming",
    }));
    return [...poiFeatures, ...metroFeatures];
  }, [activePoi.id, pois, visitedIds]);

  const mapRouteLines = useMemo<MapRouteLine[]>(() => {
    const visited = new Set(visitedIds);
    return route.legs.map((leg) => ({
      id: `${leg.fromId}->${leg.toId}`,
      points: [MOCK_POI_BY_ID[leg.fromId].position, MOCK_POI_BY_ID[leg.toId].position],
      state: visited.has(leg.fromId) && visited.has(leg.toId) ? "walked" : "upcoming",
    }));
  }, [route, visitedIds]);

  const legFrom = useMemo(
    () => new Map(route.legs.map((leg) => [leg.fromId, leg])),
    [route],
  );

  return {
    context: MOCK_JOURNEY_CONTEXT,
    remainingMinutes,
    elapsedMinutes,
    route,
    pois,
    activePoi,
    activeIndex,
    isActiveVisited,
    visitedIds,
    exploration,
    explorationStatus,
    mapFeatures,
    mapRouteLines,
    legFrom,
    geography: { lakeOutline: MOCK_LAKE_OUTLINE, streets: MOCK_STREETS },
    adapterNotes: ADAPTER_NOTES,
    disclaimer: DATA_DISCLAIMER,
    selectPoi,
    markArrived,
    toggleRoute,
  };
}

export type Journey = ReturnType<typeof useJourney>;
