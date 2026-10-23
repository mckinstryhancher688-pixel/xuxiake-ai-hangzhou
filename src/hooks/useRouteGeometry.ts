"use client";

import { useEffect, useMemo, useState } from "react";
import { GEOMETRY_ENDPOINT } from "@/lib/map/verified-scene";
import {
  createGeometryCache, geometryMode, geometryRequest, loadGeometry, pendingGeometry,
  type GeometryCache, type GeometryPlanScope, type PendingGeometry,
} from "@/lib/map/geometry-state";
import type { GeometryResponse, LatLng, VerifiedItinerary } from "@/lib/types";

export interface RouteGeometry {
  byLeg: Record<string, LatLng[]>;
  note: string | null;
}

/** 单人保留按需补查；联合模式只读正式版本存量折线，缺失时不补测。 */
export function useRouteGeometry(
  itinerary: VerifiedItinerary | null,
  planScope: GeometryPlanScope | null = null,
  jointMode = false,
): RouteGeometry {
  const planId = planScope?.planId;
  const token = planScope?.token;
  const officialRevision = planScope?.officialRevision;
  const mode = useMemo(() => geometryMode(
    planId !== undefined && token !== undefined && officialRevision !== undefined ? { planId, token, officialRevision } : null,
    jointMode,
  ), [planId, token, officialRevision, jointMode]);
  const cache = useMemo(() => createGeometryCache(mode.key), [mode.key]);
  const pendingKey = JSON.stringify(pendingGeometry(itinerary));
  const pending = useMemo(() => JSON.parse(pendingKey) as PendingGeometry[], [pendingKey]);
  const [view, setView] = useState<{ cache: GeometryCache | null; byLeg: Record<string, LatLng[]>; note: string | null }>(
    { cache: null, byLeg: {}, note: null },
  );

  useEffect(() => {
    if (mode.kind === "blocked" || !pending.length) return;
    let cancelled = false;
    void loadGeometry(cache, pending, async (missing) => {
      const joint = mode.kind === "joint";
      const safeMessage = (value: string) => mode.plan?.token ? value.split(mode.plan.token).join("[已隐藏]") : value;
      try {
        const request = geometryRequest(mode, missing);
        if (!request) throw new Error("联合模式缺少有效正式版本凭据，未请求折线");
        const response = await fetch(GEOMETRY_ENDPOINT, {
          method: "POST",
          ...request,
        });
        const data = (await response.json()) as GeometryResponse;
        if (!response.ok || data.error) throw new Error(data.error ?? `服务端返回 HTTP ${response.status}`);
        if (!Array.isArray(data.legs)) throw new Error("服务端没有返回有效的折线结果");
        if (joint && data.newCalls !== 0) throw new Error("正式版本只读请求返回了非零高德调用计数，已拒绝采用");
        const next: Record<string, LatLng[]> = {};
        const failures: string[] = [];
        for (const [index, item] of missing.entries()) {
          const outcome = data.legs.find((leg) => leg.index === index);
          if (Array.isArray(outcome?.polyline) && outcome.polyline.length >= 2) next[item.key] = outcome.polyline;
          if (outcome?.error) failures.push(`${item.toName}：${outcome.error}`);
          else if (!outcome || (outcome.polyline?.length ?? 0) < 2) failures.push(`${item.toName}：未存有可用道路折线，该段不画`);
        }
        const note = joint
          ? `正式版本仅只读已存折线，不新增高德请求；取到 ${Object.keys(next).length} 段${failures.length ? `；${failures.join("；")}` : ""}`
          : `为地图补查 ${missing.length} 段步行路线：新发起高德请求 ${data.newCalls} 次，命中缓存 ${data.cacheHits} 次${failures.length ? `；${failures.join("；")}` : ""}`;
        return { byLeg: next, note: safeMessage(note) };
      } catch (caught) {
        const message = safeMessage(caught instanceof Error ? caught.message : String(caught));
        return { byLeg: {}, note: joint
          ? `正式版本存量折线读取失败：${message}。缺几何路段不画；不会降级补测高德。`
          : `道路几何补查失败：${message}。缺几何的路段地图上不画。` };
      }
    }).then(() => {
      if (!cancelled) setView({ cache, byLeg: { ...cache.byLeg }, note: cache.note });
    });
    return () => { cancelled = true; };
  }, [cache, mode, pending]);

  if (mode.kind === "blocked") return { byLeg: {}, note: "联合模式缺少有效正式版本凭据，未请求折线，也不会补测高德。" };
  return view.cache === cache ? { byLeg: view.byLeg, note: view.note }
    : { byLeg: {}, note: mode.kind === "joint" ? "正式版本只读已存折线，不新增高德请求。" : null };
}
