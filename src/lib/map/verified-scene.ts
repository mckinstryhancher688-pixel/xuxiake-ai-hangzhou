import { stopIdOf } from "../types.ts";
import type { MapFeature, MapFeatureState, MapRouteLine } from "@/components/map/types";
import type { LatLng, VerifiedItinerary, WalkingLeg } from "@/lib/types";

export const START_FEATURE_ID = "amap-start";
export const GEOMETRY_ENDPOINT = "/api/route-geometry";

/** 一段路的稳定标识：服务端补查回来的几何按它对齐，换行程也不会重复请求同一段。 */
export function legKey(leg: WalkingLeg): string {
  const point = (p: LatLng) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
  return `${point(leg.from)}|${point(leg.to)}`;
}

export interface MapScene {
  features: MapFeature[];
  routeLines: MapRouteLine[];
  /** 高德没返回道路几何、因此地图上刻意没画的路段（不补直线） */
  undrawnLegs: string[];
}

/**
 * 把「已核验行程」翻译成地图视图契约。
 * 坐标一律用核验后的高德 POI 位置，折线一律用高德步行规划的 polyline；
 * 飞猪原始坐标和两点直线在这里都没有入口。
 */
export function buildVerifiedScene(
  itinerary: VerifiedItinerary,
  arrivedStopIds: string[],
  activeStopId: string | null,
  geometry: Record<string, LatLng[]> = {},
): MapScene {
  const arrived = new Set(arrivedStopIds);

  const features: MapFeature[] = [
    {
      id: START_FEATURE_ID,
      name: itinerary.start.name,
      kind: "start",
      position: itinerary.start.position,
      state: "visited",
    },
    ...itinerary.stops.map<MapFeature>((stop, index) => {
      const state: MapFeatureState =
        stopIdOf(stop) === activeStopId
          ? "active"
          : arrived.has(stopIdOf(stop))
            ? "visited"
            : "upcoming";
      return {
        id: stopIdOf(stop),
        name: stop.name,
        kind: "poi",
        position: stop.position,
        order: index + 1,
        state,
      };
    }),
  ];

  const routeLines: MapRouteLine[] = [];
  const undrawnLegs: string[] = [];

  itinerary.stops.forEach((stop, index) => {
    const leg = itinerary.legs[index];
    if (!leg) return;
    const label = `${leg.fromName} → ${leg.toName}`;
    // 报告里可能没有几何（早于本功能生成的缓存报告），就用按需补查回来的那份；
    // 两者都没有就不画这一段，绝不拿两点直线冒充导航线。
    const path = leg.polyline?.length ? leg.polyline : (geometry[legKey(leg)] ?? []);
    if (path.length < 2) {
      undrawnLegs.push(label);
      return;
    }
    routeLines.push({
      id: `${START_FEATURE_ID}->${stopIdOf(stop)}-${index}`,
      points: path,
      state: arrived.has(stopIdOf(stop)) ? "walked" : "upcoming",
    });
  });

  return { features, routeLines, undrawnLegs };
}
