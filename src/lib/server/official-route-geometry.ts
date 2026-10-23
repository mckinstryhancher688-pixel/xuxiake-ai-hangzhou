import { AUTH_FAILURE, MAX_ID_LENGTH, readToken } from "./plan-http";
import { executionBlockReason, identifyRole, planExecutionJourney } from "./plan-store";
import type { GeometryLegOutcome, GeometryResponse, LatLng } from "@/lib/types";

if (typeof window !== "undefined") {
  throw new Error("lib/server/official-route-geometry 只能在 Next.js 服务端加载。");
}

export function geometryFailure(error: string, status: number): { status: number; result: GeometryResponse } {
  return { status, result: { legs: [], newCalls: 0, cacheHits: 0, error } };
}

function point(value: unknown): LatLng | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { lat, lng } = value as Record<string, unknown>;
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function samePoint(a: LatLng, b: LatLng): boolean {
  return a.lat === b.lat && a.lng === b.lng;
}

/** 只读正式版本保存的有向路段；缺几何也不能借此入口触发任何补测。 */
export function readOfficialRouteGeometry(request: Request, body: Record<string, unknown>): { status: number; result: GeometryResponse } {
  const { planId, officialRevision } = body;
  if (typeof planId !== "string" || !planId.trim() || planId !== planId.trim() || planId.length > MAX_ID_LENGTH) {
    return geometryFailure("联合路线必须带合法的 planId，未补查高德。", 400);
  }
  if (typeof officialRevision !== "number" || !Number.isSafeInteger(officialRevision) || officialRevision < 1) {
    return geometryFailure("联合路线必须带正式版本号 officialRevision，未补查高德。", 400);
  }
  const identity = identifyRole(planId, readToken(request));
  if ("error" in identity) {
    const failure = AUTH_FAILURE[identity.error] ?? AUTH_FAILURE["bad-token"];
    return geometryFailure(failure.message, failure.status);
  }
  const journey = planExecutionJourney(planId);
  if (!journey) return geometryFailure(executionBlockReason(planId), 409);
  if (journey.officialRevision !== officialRevision) {
    return geometryFailure("正式行程版本已变化，请刷新后查看当前版本；未补查高德。", 409);
  }
  if (!Array.isArray(body.legs) || body.legs.length > 8) {
    return geometryFailure("legs 必须是最多 8 段的数组，未补查高德。", 400);
  }

  const legs: GeometryLegOutcome[] = [];
  for (const [index, raw] of body.legs.entries()) {
    const values = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const from = point(values?.from);
    const to = point(values?.to);
    if (!from || !to) return geometryFailure("请求路段的坐标不合法，未补查高德。", 400);
    const stored = journey.itinerary.legs.find((leg) => samePoint(leg.from, from) && samePoint(leg.to, to));
    if (!stored) return geometryFailure("请求的有向路段不属于当前正式行程，未补查高德。", 409);
    const hasGeometry = Array.isArray(stored.polyline) && stored.polyline.length >= 2;
    legs.push({
      index,
      polyline: hasGeometry ? stored.polyline : [],
      fromCache: hasGeometry,
      distanceMeters: stored.distanceMeters,
      error: hasGeometry ? null : "这段正式路线未保存道路几何，地图上不会画它；未补查高德。",
    });
  }
  return { status: 200, result: { legs, newCalls: 0, cacheHits: legs.filter((leg) => leg.fromCache).length, error: null } };
}
