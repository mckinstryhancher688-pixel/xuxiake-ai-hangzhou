import type { AmapCallLogEntry, AmapPoi, LatLng } from "@/lib/types";
import { parseAmapLocation } from "@/lib/geo";
import { AsyncLocalStorage } from "node:async_hooks";

const requestBudget = new AsyncLocalStorage<(api: string) => void>();
/** Trip callers persistently charge every HTTP attempt, including retries. Legacy callers keep their interface. */
export function withAmapBudget<T>(beforeRequest: (api: string) => void, work: () => Promise<T>): Promise<T> {
  return requestBudget.run(beforeRequest, work);
}

if (typeof window !== "undefined") {
  throw new Error("lib/server/amap 只能在 Next.js 服务端加载。");
}

/**
 * 高德 Web 服务 API 的服务端封装。
 *
 * 安全约束（第三阶段明确要求）：
 *  - key 只从服务端环境变量 AMAP_WEB_KEY 读取，不进客户端 bundle；
 *  - 任何日志、返回值、异常文本里都不出现 key，也不出现带 key 的完整 URL。
 *    做法是：日志只序列化业务参数，key 在真正发请求前才拼进 URL。
 */

const BASE_URL = "https://restapi.amap.com";
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 高德个人 key 的并发/QPS 余量很小：实测并发 2 直接刷出 16 次
 * CUQPS_HAS_EXCEEDED_THE_LIMIT(infocode=10021)。所以所有请求在这里排队串行，
 * 并强制最小间隔（≈2.5 QPS），限流时退避重试而不是当成真实失败上报。
 */
const MIN_INTERVAL_MS = 400;
const RATE_LIMIT_INFOCODE = "10021";
const RATE_LIMIT_BACKOFF_MS = [600, 1500, 3000];

/** POI 与步行路径都很稳定，6 小时缓存足以让重复点击零成本。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** 一次完整核验约需 21 次 POI 搜索 + 50 次路径规划，上限留一倍余量。 */
const PLACE_HOURLY_CAP = 40;
const WALKING_HOURLY_CAP = 80;
const HOUR_MS = 60 * 60 * 1000;

export interface AmapCallResult<T> {
  ok: boolean;
  measuredAt?: string;
  data: T | null;
  error: string | null;
  entry: AmapCallLogEntry;
}

export interface AmapWalkingData {
  distanceMeters: number;
  durationSeconds: number;
  stepCount: number;
  firstInstruction: string | null;
  /** 沿真实道路的折线；高德没给几何则为空数组 */
  polyline: LatLng[];
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

const placeCache = new Map<string, CacheEntry<AmapPoi[]>>();
const walkingCache = new Map<string, CacheEntry<AmapWalkingData>>();
const placeInflight = new Map<string, Promise<AmapCallResult<AmapPoi[]>>>();
const walkingInflight = new Map<string, Promise<AmapCallResult<AmapWalkingData>>>();
const placeStamps: number[] = [];
const walkingStamps: number[] = [];

let cacheHits = 0;
let failedCalls = 0;
let lastRequestAt = 0;
let queueTail: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 全局串行闸门：任何时刻只有一个高德请求在飞，且相邻请求间隔不小于 MIN_INTERVAL_MS。 */
function schedule<T>(work: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return work();
  });
  // 单次失败不能把后续请求全堵死
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function readAmapKey(): string | null {
  return process.env.AMAP_WEB_KEY?.trim() || null;
}

export function maskAmapKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-2)}`;
}

function prune<T>(cache: Map<string, CacheEntry<T>>): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
}

function pruneStamps(stamps: number[]): void {
  const cutoff = Date.now() - HOUR_MS;
  while (stamps.length && stamps[0] < cutoff) stamps.shift();
}

export interface AmapCounters {
  keyPresent: boolean;
  keyMask: string | null;
  placeCalls: number;
  walkingCalls: number;
  cacheHits: number;
  failedCalls: number;
  placeHourlyCap: number;
  walkingHourlyCap: number;
  cacheTtlSeconds: number;
  cacheEntries: number;
}

export function amapCounters(): AmapCounters {
  prune(placeCache);
  prune(walkingCache);
  pruneStamps(placeStamps);
  pruneStamps(walkingStamps);
  const key = readAmapKey();
  return {
    keyPresent: Boolean(key),
    keyMask: maskAmapKey(key),
    placeCalls: placeStamps.length,
    walkingCalls: walkingStamps.length,
    cacheHits,
    failedCalls,
    placeHourlyCap: PLACE_HOURLY_CAP,
    walkingHourlyCap: WALKING_HOURLY_CAP,
    cacheTtlSeconds: CACHE_TTL_MS / 1000,
    cacheEntries: placeCache.size + walkingCache.size,
  };
}

function makeEntry(
  api: AmapCallLogEntry["api"],
  params: Record<string, string | number | boolean>,
  fromCache: boolean,
): AmapCallLogEntry {
  return {
    at: new Date().toISOString(),
    api,
    // 只序列化业务参数，key 从来不在这个对象里
    params: new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    ).toString(),
    httpStatus: null,
    infocode: null,
    info: null,
    durationMs: 0,
    retries: 0,
    fromCache,
    error: null,
  };
}

interface AmapEnvelope {
  status?: string;
  infocode?: string;
  info?: string;
  count?: string;
  pois?: unknown[];
  route?: { origin?: string; destination?: string; paths?: unknown[] };
}

interface RawResponse {
  ok: boolean;
  envelope: AmapEnvelope | null;
  httpStatus: number | null;
  error: string | null;
}

async function request(
  path: string,
  params: Record<string, string | number | boolean>,
  key: string,
): Promise<RawResponse & { retries: number }> {
  let last: RawResponse = { ok: false, envelope: null, httpStatus: null, error: "未发起请求" };
  for (let attempt = 0; ; attempt += 1) {
    last = await schedule(() => { requestBudget.getStore()?.(path); return fetchOnce(path, params, key); });
    // 10021 是「每秒请求数超限」，属于可恢复的瞬时限流，退避后重试；
    // 日配额超限(10003)之类的硬失败不重试，直接如实上报。
    if (last.ok || last.envelope?.infocode !== RATE_LIMIT_INFOCODE) {
      return { ...last, retries: attempt };
    }
    if (attempt >= RATE_LIMIT_BACKOFF_MS.length) return { ...last, retries: attempt };
    await sleep(RATE_LIMIT_BACKOFF_MS[attempt]);
  }
}

async function fetchOnce(
  path: string,
  params: Record<string, string | number | boolean>,
  key: string,
): Promise<RawResponse> {
  const url = new URL(BASE_URL + path);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  url.searchParams.set("key", key);

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "user-agent": "xiaxiake-ai/phase3" },
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        envelope: null,
        httpStatus: response.status,
        // 响应体可能回显请求参数，截断并去掉 key 形状的串再抛出
        error: `高德返回 HTTP ${response.status}：${scrub(text.slice(0, 200), key)}`,
      };
    }
    let envelope: AmapEnvelope;
    try {
      envelope = JSON.parse(text) as AmapEnvelope;
    } catch (error) {
      return {
        ok: false,
        envelope: null,
        httpStatus: response.status,
        error: `高德响应不是合法 JSON：${(error as Error).message}`,
      };
    }
    if (envelope.status !== "1") {
      return {
        ok: false,
        envelope,
        httpStatus: response.status,
        error: `高德返回失败：info=${envelope.info ?? "无"} infocode=${envelope.infocode ?? "无"}`,
      };
    }
    return { ok: true, envelope, httpStatus: response.status, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      envelope: null,
      httpStatus: null,
      error: `请求高德失败：${scrub(message, key)}`,
    };
  }
}

/** 兜底脱敏：万一异常文本里带出了 key，替换掉再往外传。 */
function scrub(text: string, key: string): string {
  return key ? text.split(key).join("<hidden>") : text;
}

/* ── POI 搜索 2.0 ─────────────────────────────────────────────────── */

export async function searchPlace(
  keywords: string,
  options: { region?: string; cityLimit?: boolean; showBusiness?: boolean; pageSize?: number } = {},
): Promise<AmapCallResult<AmapPoi[]>> {
  const params: Record<string, string | number | boolean> = {
    keywords,
    region: options.region ?? "杭州",
    city_limit: options.cityLimit ?? true,
    page_size: options.pageSize ?? 5,
    ...(options.showBusiness === false ? {} : { show_fields: "business" }),
  };
  const cacheKey = JSON.stringify(params);
  prune(placeCache);

  const hit = placeCache.get(cacheKey);
  if (hit) {
    cacheHits += 1;
    return {
      ok: true,
      data: hit.value,
      error: null,
      entry: makeEntry("place/text", params, true),
      measuredAt: new Date(hit.at).toISOString(),
    };
  }

  const pending = placeInflight.get(cacheKey);
  if (pending) return pending;

  const task = runPlace(params, cacheKey);
  placeInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    placeInflight.delete(cacheKey);
  }
}

async function runPlace(
  params: Record<string, string | number | boolean>,
  cacheKey: string,
): Promise<AmapCallResult<AmapPoi[]>> {
  const entry = makeEntry("place/text", params, false);
  const key = readAmapKey();
  if (!key) {
    entry.error = "服务端没有读到 AMAP_WEB_KEY，已拒绝发起高德调用。";
    failedCalls += 1;
    return { ok: false, data: null, error: entry.error, entry };
  }

  pruneStamps(placeStamps);
  if (placeStamps.length >= PLACE_HOURLY_CAP) {
    entry.error = `本小时 POI 搜索已达上限（${PLACE_HOURLY_CAP} 次），已拒绝新调用。`;
    failedCalls += 1;
    return { ok: false, data: null, error: entry.error, entry };
  }

  placeStamps.push(Date.now());
  const started = Date.now();
  const result = await request("/v5/place/text", params, key);
  entry.durationMs = Date.now() - started;
  entry.retries = result.retries;
  entry.httpStatus = result.httpStatus;
  entry.infocode = result.envelope?.infocode ?? null;
  entry.info = result.envelope?.info ?? null;
  entry.error = result.error;

  if (!result.ok) {
    failedCalls += 1;
    return { ok: false, data: null, error: result.error, entry };
  }

  const pois = (result.envelope?.pois ?? []).flatMap((raw) => {
    const poi = toAmapPoi(raw);
    return poi ? [poi] : [];
  });
  placeCache.set(cacheKey, { at: Date.now(), value: pois });
  return { ok: true, data: pois, error: null, entry, measuredAt: entry.at };
}

function toText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function toAmapPoi(raw: unknown): AmapPoi | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = toText(record.id);
  const name = toText(record.name);
  const position = parseAmapLocation(record.location);
  if (!id || !name || !position) return null;

  const business = (record.business ?? null) as Record<string, unknown> | null;
  return {
    id,
    name,
    address: toText(record.address),
    adname: toText(record.adname),
    typecode: toText(record.typecode),
    position,
    // 高德对很多 POI 不给营业时间，缺失就是缺失，不编
    opentime: toText(business?.opentime_today ?? business?.opentime_week ?? null),
    rating: toText(business?.rating),
  };
}

/* ── 步行路径规划 2.0 ─────────────────────────────────────────────── */

export function toAmapCoordinate(point: LatLng): string {
  // 高德顺序是「经度,纬度」，与本项目 LatLng 相反
  return `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`;
}

export async function planWalking(
  origin: LatLng,
  destination: LatLng,
): Promise<AmapCallResult<AmapWalkingData>> {
  // polyline 字段是实测出来的必要条件：show_fields=cost 时 steps 里根本没有折线，
  // 加上 cost,polyline 才按步给出「lng,lat;…」的真实道路几何。
  const params = {
    origin: toAmapCoordinate(origin),
    destination: toAmapCoordinate(destination),
    show_fields: "cost,polyline",
  };
  const cacheKey = `${params.origin}|${params.destination}`;
  prune(walkingCache);

  const hit = walkingCache.get(cacheKey);
  // 旧缓存条目可能只有距离耗时。缺几何时宁可重查一次高德，也不在客户端拿直线补。
  if (hit && hit.value.polyline.length > 0) {
    cacheHits += 1;
    return { ok: true, data: hit.value, error: null, entry: makeEntry("direction/walking", params, true), measuredAt: new Date(hit.at).toISOString() };
  }

  const pending = walkingInflight.get(cacheKey);
  if (pending) return pending;

  const task = runWalking(params, cacheKey);
  walkingInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    walkingInflight.delete(cacheKey);
  }
}

async function runWalking(
  params: Record<string, string>,
  cacheKey: string,
): Promise<AmapCallResult<AmapWalkingData>> {
  const entry = makeEntry("direction/walking", params, false);
  const key = readAmapKey();
  if (!key) {
    entry.error = "服务端没有读到 AMAP_WEB_KEY，已拒绝发起高德调用。";
    failedCalls += 1;
    return { ok: false, data: null, error: entry.error, entry };
  }

  pruneStamps(walkingStamps);
  if (walkingStamps.length >= WALKING_HOURLY_CAP) {
    entry.error = `本小时步行路径规划已达上限（${WALKING_HOURLY_CAP} 次），已拒绝新调用。`;
    failedCalls += 1;
    return { ok: false, data: null, error: entry.error, entry };
  }

  walkingStamps.push(Date.now());
  const started = Date.now();
  const result = await request("/v5/direction/walking", params, key);
  entry.durationMs = Date.now() - started;
  entry.retries = result.retries;
  entry.httpStatus = result.httpStatus;
  entry.infocode = result.envelope?.infocode ?? null;
  entry.info = result.envelope?.info ?? null;
  entry.error = result.error;

  if (!result.ok) {
    failedCalls += 1;
    return { ok: false, data: null, error: result.error, entry };
  }

  const path = result.envelope?.route?.paths?.[0] as Record<string, unknown> | undefined;
  if (!path) {
    entry.error = "高德返回成功但 paths 为空，两点之间可能没有可步行路线。";
    failedCalls += 1;
    return { ok: false, data: null, error: entry.error, entry };
  }

  const distanceMeters = Number(path.distance);
  const cost = path.cost as Record<string, unknown> | undefined;
  const durationSeconds = Number(cost?.duration);
  if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
    entry.error = `高德返回的距离或耗时无法解析：distance=${String(path.distance)} duration=${String(cost?.duration)}`;
    failedCalls += 1;
    return { ok: false, data: null, error: entry.error, entry };
  }

  const steps = Array.isArray(path.steps) ? (path.steps as Record<string, unknown>[]) : [];
  const data: AmapWalkingData = {
    distanceMeters: Math.round(distanceMeters),
    durationSeconds: Math.round(durationSeconds),
    stepCount: steps.length,
    firstInstruction: toText(steps[0]?.instruction) ?? null,
    polyline: mergeStepPolylines(steps),
  };
  walkingCache.set(cacheKey, { at: Date.now(), value: data });
  return { ok: true, data, error: null, entry, measuredAt: entry.at };
}

/**
 * 高德把一条路线的几何按 step 分段给出，形如 "lng,lat;lng,lat"。
 * 相邻段首尾点重复，去掉重复点后串起来才是完整折线。
 */
function mergeStepPolylines(steps: Record<string, unknown>[]): LatLng[] {
  const merged: LatLng[] = [];
  for (const step of steps) {
    if (typeof step.polyline !== "string") continue;
    for (const item of step.polyline.split(";")) {
      const point = parseAmapLocation(item);
      if (!point) continue;
      const last = merged[merged.length - 1];
      if (last && last.lat === point.lat && last.lng === point.lng) continue;
      merged.push(point);
    }
  }
  return merged;
}
