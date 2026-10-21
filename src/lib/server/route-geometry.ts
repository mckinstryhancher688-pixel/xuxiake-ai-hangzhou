import { amapCounters, planWalking } from "@/lib/server/amap";
import type {
  GeometryLegOutcome,
  GeometryLegRequest,
  GeometryResponse,
  LatLng,
} from "@/lib/types";

if (typeof window !== "undefined") {
  throw new Error("lib/server/route-geometry 只能在 Next.js 服务端加载。");
}

/**
 * 按需补查步行折线（第六阶段要求：缓存里没有 polyline 就补查并缓存，严禁伪造导航折线）。
 *
 * 存在的理由：核验流水线整体缓存 30 分钟，早于本功能生成的报告里没有道路几何。
 * 与其为了几条折线重跑几十次高德调用，只对地图上真正要画的那几段各查一次——
 * planWalking 内部已有 6 小时缓存、串行限流与每小时上限，这里不重复造轮子。
 */

/** 一张地图最多画得起几条腿；再多就是被拿去做批量爬取了。 */
const MAX_LEGS_PER_REQUEST = 8;

function asPoint(value: unknown): LatLng | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Record<string, unknown>;
  const { lat, lng } = point;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function asLeg(value: unknown): GeometryLegRequest | null {
  if (!value || typeof value !== "object") return null;
  const leg = value as Record<string, unknown>;
  const from = asPoint(leg.from);
  const to = asPoint(leg.to);
  return from && to ? { from, to } : null;
}

export async function fetchRouteGeometry(body: unknown): Promise<GeometryResponse> {
  const rawLegs = (body as { legs?: unknown })?.legs;
  if (!Array.isArray(rawLegs)) {
    return { legs: [], newCalls: 0, cacheHits: 0, error: "请求体缺少 legs 数组。" };
  }
  if (rawLegs.length > MAX_LEGS_PER_REQUEST) {
    return {
      legs: [],
      newCalls: 0,
      cacheHits: 0,
      error: `一次最多补查 ${MAX_LEGS_PER_REQUEST} 段，收到 ${rawLegs.length} 段。`,
    };
  }

  const before = amapCounters();
  const legs: GeometryLegOutcome[] = [];

  for (const [index, raw] of rawLegs.entries()) {
    const leg = asLeg(raw);
    if (!leg) {
      legs.push({
        index,
        polyline: [],
        fromCache: false,
        distanceMeters: null,
        error: "这段的坐标不合法，没有去请求高德。",
      });
      continue;
    }

    // 串行而不是并发：高德个人 key 每秒只扛得住 2~3 次请求
    const result = await planWalking(leg.from, leg.to);
    if (!result.ok || !result.data) {
      legs.push({
        index,
        polyline: [],
        fromCache: false,
        distanceMeters: null,
        error: result.error ?? "高德没有返回这段路线。",
      });
      continue;
    }

    legs.push({
      index,
      polyline: result.data.polyline,
      fromCache: result.entry.fromCache,
      distanceMeters: result.data.distanceMeters,
      error:
        result.data.polyline.length >= 2
          ? null
          : "高德返回了这段路线，但没有给出道路几何，地图上不会画它。",
    });
  }

  const after = amapCounters();
  return {
    legs,
    newCalls: after.walkingCalls - before.walkingCalls,
    cacheHits: after.cacheHits - before.cacheHits,
    error: null,
  };
}
