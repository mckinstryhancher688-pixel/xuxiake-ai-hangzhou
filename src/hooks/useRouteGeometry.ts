"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GEOMETRY_ENDPOINT, legKey } from "@/lib/map/verified-scene";
import type { GeometryResponse, LatLng, VerifiedItinerary } from "@/lib/types";

export interface RouteGeometry {
  /** key = legKey(leg)，值 = 高德返回的道路折线 */
  byLeg: Record<string, LatLng[]>;
  /** 给调试面板看的一句话：这次为地图真实补查了几段高德步行路线 */
  note: string | null;
}

/**
 * 报告里没有道路几何的路段，按段向服务端补查一次并缓存。
 * 同一段只查一次（换行程、换选中都不会重复消耗配额）。
 */
export function useRouteGeometry(itinerary: VerifiedItinerary | null): RouteGeometry {
  const [byLeg, setByLeg] = useState<Record<string, LatLng[]>>({});
  const [note, setNote] = useState<string | null>(null);
  const requested = useRef(new Set<string>());

  /** 报告里缺几何的路段；是否真的查过由 effect 里的 requested 决定 */
  const pending = useMemo(() => {
    if (!itinerary) return [];
    return itinerary.legs
      .map((leg) => ({ leg, key: legKey(leg) }))
      .filter((item) => (item.leg.polyline?.length ?? 0) < 2);
  }, [itinerary]);

  useEffect(() => {
    const missing = pending.filter((item) => !requested.current.has(item.key));
    if (!missing.length) return;
    for (const item of missing) requested.current.add(item.key);

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(GEOMETRY_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            legs: missing.map((item) => ({ from: item.leg.from, to: item.leg.to })),
          }),
        });
        const data = (await response.json()) as GeometryResponse;
        if (cancelled) return;

        const next: Record<string, LatLng[]> = {};
        const failures: string[] = [];
        for (const outcome of data.legs) {
          const item = missing[outcome.index];
          if (!item) continue;
          if (outcome.polyline.length >= 2) next[item.key] = outcome.polyline;
          if (outcome.error) failures.push(`${item.leg.toName}：${outcome.error}`);
        }
        setByLeg((prev) => ({ ...prev, ...next }));
        setNote(
          `为地图补查 ${missing.length} 段步行路线：新发起高德请求 ${data.newCalls} 次，` +
            `命中缓存 ${data.cacheHits} 次${failures.length ? `；${failures.join("；")}` : ""}`,
        );
      } catch (caught) {
        if (cancelled) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        setNote(`道路几何补查失败：${message}。缺几何的路段地图上不画。`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pending]);

  return { byLeg, note };
}
