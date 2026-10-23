import { legKey } from "./verified-scene.ts";
import type { LatLng, VerifiedItinerary } from "../types.ts";
import { ROLE_TOKEN_HEADER } from "../plan-api.ts";

export interface GeometryPlanScope { planId: string; token: string; officialRevision: number }
export interface GeometryMode {
  kind: "solo" | "joint" | "blocked";
  /** 仅在内存中隔离缓存，不进入请求正文、返回值或调试文案。 */
  key: string;
  plan: GeometryPlanScope | null;
}
export function geometryMode(scope: GeometryPlanScope | null | undefined, jointMode: boolean): GeometryMode {
  if (!jointMode) return { kind: "solo", key: "solo", plan: null };
  if (typeof scope?.planId !== "string" || !scope.planId.trim() || typeof scope.token !== "string" || !scope.token.trim() ||
    !Number.isInteger(scope.officialRevision) || scope.officialRevision < 1) {
    return { kind: "blocked", key: "joint-blocked", plan: null };
  }
  return { kind: "joint", key: JSON.stringify(["joint", scope.planId, scope.officialRevision, scope.token]), plan: scope };
}

export interface PendingGeometry { key: string; from: LatLng; to: LatLng; toName: string }
export function geometryRequest(mode: GeometryMode, missing: PendingGeometry[]): { headers: Record<string, string>; body: string } | null {
  if (mode.kind === "blocked" || (mode.kind === "joint" && !mode.plan)) return null;
  const joint = mode.kind === "joint" && mode.plan !== null;
  return {
    headers: { "content-type": "application/json", ...(joint ? { [ROLE_TOKEN_HEADER]: mode.plan!.token } : {}) },
    body: JSON.stringify({
      legs: missing.map((item) => ({ from: item.from, to: item.to })),
      ...(joint ? { planId: mode.plan!.planId, officialRevision: mode.plan!.officialRevision } : {}),
    }),
  };
}
/** 只投影请求实际需要的字段，让相同正式版本的轮询对象得到同一个稳定键。 */
export function pendingGeometry(itinerary: VerifiedItinerary | null): PendingGeometry[] {
  const seen = new Set<string>();
  return (itinerary?.legs ?? []).flatMap((leg) => {
    const key = legKey(leg);
    if ((leg.polyline?.length ?? 0) >= 2 || seen.has(key)) return [];
    seen.add(key);
    return [{ key, from: leg.from, to: leg.to, toName: leg.toName }];
  });
}

export interface GeometryLoadResult { byLeg: Record<string, LatLng[]>; note: string }
export interface GeometryCache {
  scopeKey: string;
  byLeg: Record<string, LatLng[]>;
  note: string | null;
  completed: Set<string>;
  tasks: Map<string, Promise<void>>;
}
export function createGeometryCache(scopeKey = "solo"): GeometryCache {
  return { scopeKey, byLeg: {}, note: null, completed: new Set(), tasks: new Map() };
}

/**
 * 在途与已完成分开：effect 的订阅者退出不取消请求，StrictMode 新订阅者接同一 Promise。
 * 各作用域使用不同 cache；旧请求只填自己的 cache，不会污染新版本/另一角色。
 */
export async function loadGeometry(
  cache: GeometryCache,
  pending: PendingGeometry[],
  load: (missing: PendingGeometry[]) => Promise<GeometryLoadResult>,
): Promise<void> {
  const missing = pending.filter((item) => !cache.completed.has(item.key) && !cache.tasks.has(item.key));
  if (missing.length) {
    const task = Promise.resolve().then(() => load(missing)).then((result) => {
      cache.byLeg = { ...cache.byLeg, ...result.byLeg };
      cache.note = result.note;
    }).catch(() => {
      cache.note = "道路几何读取失败，缺失路段不画；不会自动重复请求。";
    }).finally(() => {
      for (const item of missing) { cache.completed.add(item.key); cache.tasks.delete(item.key); }
    });
    for (const item of missing) cache.tasks.set(item.key, task);
  }
  const tasks = [...new Set(pending.map((item) => cache.tasks.get(item.key)).filter((task): task is Promise<void> => Boolean(task)))];
  await Promise.all(tasks);
}
