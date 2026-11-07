import type { FlyAiServerStatus } from "@/lib/discovery";
import type {
  DiscoverBatch,
  DiscoverCategoryResult,
  DiscoveredPoi,
  DiscoveredPoiMissingField,
  FlyAiCallProof,
  LatLng,
} from "@/lib/types";
import { describeCliEntry, resolveCliEntry, runFlyAiPoiSearch, tail } from "./flyai-cli";

if (typeof window !== "undefined") {
  throw new Error("lib/server/discover 只能在 Next.js 服务端加载。");
}

/** 命中缓存就不发真实请求：同一城市+类别 10 分钟内只花一次钱。 */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** 每小时最多真实 spawn 多少次 CLI，防止连点或多标签页刷出费用。 */
const HOURLY_CALL_CAP = 12;
const HOUR_MS = 60 * 60 * 1000;

interface CacheEntry {
  at: number;
  result: DiscoverCategoryResult;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<DiscoverCategoryResult>>();
const spawnTimestamps: number[] = [];

function maskApiKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}****${key.slice(-2)}`;
}

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
}

function pruneSpawnTimestamps(): void {
  const cutoff = Date.now() - HOUR_MS;
  while (spawnTimestamps.length && spawnTimestamps[0] < cutoff) spawnTimestamps.shift();
}

/** GET /api/discover 的返回体。只暴露布尔值与脱敏形状，绝不返回 key 本身。 */
export function discoverStatus(): FlyAiServerStatus {
  pruneCache();
  pruneSpawnTimestamps();
  const apiKey = process.env.FLYAI_API_KEY?.trim();
  const cliEntry = resolveCliEntry();
  const now = Date.now();
  return {
    keyPresent: Boolean(apiKey),
    keyMask: maskApiKey(apiKey),
    cliEntry: describeCliEntry(cliEntry),
    cliAvailable: Boolean(cliEntry),
    cacheTtlSeconds: CACHE_TTL_MS / 1000,
    cacheEntries: [...cache.entries()].map(([key, entry]) => ({
      key,
      ageSeconds: Math.round((now - entry.at) / 1000),
      itemCount: entry.result.items.length,
    })),
    hourlyCallsUsed: spawnTimestamps.length,
    hourlyCallCap: HOURLY_CALL_CAP,
    serverTime: new Date().toISOString(),
    pid: process.pid,
  };
}

export async function discoverCity(
  cityName: string,
  categories: string[],
): Promise<DiscoverBatch> {
  const fetchedAt = new Date().toISOString();
  const apiKey = process.env.FLYAI_API_KEY?.trim();
  const cliEntry = resolveCliEntry();

  if (!apiKey) {
    return failedBatch(
      cityName,
      categories,
      fetchedAt,
      "服务端没有读到 FLYAI_API_KEY。flyai CLI 在没有 key 时会静默改用打包进产物的第三方默认凭证（消耗别人的额度），所以这里直接拒绝发起调用。请在项目根目录 .env.local 写入 FLYAI_API_KEY 后重启 dev server。",
    );
  }
  if (!cliEntry) {
    return failedBatch(
      cityName,
      categories,
      fetchedAt,
      "服务端找不到 @fly-ai/flyai-cli 的入口文件。本地请先 npm install（它是项目依赖，全局安装也可以）；" +
        "部署环境要确认它被打进函数产物（next.config.ts 的 outputFileTracingIncludes），或设置 FLYAI_CLI_ROOT 指向可用的 node_modules。",
    );
  }

  const results: DiscoverCategoryResult[] = [];
  // 串行：一次「重新发现」最多产生 MAX_CATEGORIES_PER_CALL 次真实调用，且不会并发放大
  for (const category of categories) {
    results.push(await discoverCategory(cityName, category, apiKey));
  }

  const ok = results.some((result) => !result.error && result.items.length > 0);
  return {
    cityName,
    origin: "flyai-live",
    fetchedAt,
    ok,
    error: ok
      ? null
      : results.map((result) => `「${result.category}」${result.error ?? "未返回数据"}`).join("；"),
    results,
  };
}

function failedBatch(
  cityName: string,
  categories: string[],
  fetchedAt: string,
  error: string,
): DiscoverBatch {
  console.error(`[flyai] 拒绝调用：${error}`);
  return {
    cityName,
    origin: "flyai-live",
    fetchedAt,
    ok: false,
    error,
    results: categories.map((category) => ({ category, items: [], error, proof: null })),
  };
}

async function discoverCategory(
  cityName: string,
  category: string,
  apiKey: string,
): Promise<DiscoverCategoryResult> {
  const cacheKey = `${cityName}|${category}`;
  pruneCache();

  const hit = cache.get(cacheKey);
  if (hit) return asCacheHit(hit.result);

  // 并发点击复用同一个在途请求，避免重复计费
  const pending = inflight.get(cacheKey);
  if (pending) return asCacheHit(await pending);

  const task = callCategory(cityName, category, apiKey);
  inflight.set(cacheKey, task);
  try {
    const result = await task;
    // 只缓存成功结果，失败要允许立刻重试
    if (!result.error) cache.set(cacheKey, { at: Date.now(), result });
    return result;
  } finally {
    inflight.delete(cacheKey);
  }
}

function asCacheHit(result: DiscoverCategoryResult): DiscoverCategoryResult {
  return {
    ...result,
    proof: result.proof ? { ...result.proof, cacheHit: true } : null,
  };
}

async function callCategory(
  cityName: string,
  category: string,
  apiKey: string,
): Promise<DiscoverCategoryResult> {
  pruneSpawnTimestamps();
  if (spawnTimestamps.length >= HOURLY_CALL_CAP) {
    const error = `本小时真实调用已达上限（${HOURLY_CALL_CAP} 次），已拒绝新的调用以避免继续产生费用。请等待缓存过期或下个整点。`;
    console.warn(`[flyai] ${error}`);
    return { category, items: [], error, proof: null };
  }

  spawnTimestamps.push(Date.now());
  const run = await runFlyAiPoiSearch({ cityName, category, apiKey });
  const proof: Omit<FlyAiCallProof, "rawItemCount"> = {
    invokedAt: new Date().toISOString(),
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    command: run.command,
    cliEntry: run.cliEntry ?? "",
    keySource: "env:FLYAI_API_KEY",
    stdoutBytes: Buffer.byteLength(run.stdout, "utf8"),
    cacheHit: false,
  };

  console.log(
    `[flyai] search-poi city=${cityName} category=${category} exit=${run.exitCode} ` +
      `${run.durationMs}ms stdout=${proof.stdoutBytes}B spawnError=${run.error ?? "none"}`,
  );

  if (run.error) {
    return { category, items: [], error: run.error, proof: { ...proof, rawItemCount: 0 } };
  }
  return parsePoiPayload(category, run.stdout, proof);
}

interface PoiEnvelope {
  status?: number;
  message?: string;
  systemMessage?: string | null;
  data?: { itemList?: unknown[] };
}

/** 导出仅供零付费夹具测试：解析是纯函数，不发起任何调用。 */
export function parsePoiPayload(
  category: string,
  stdout: string,
  proof: Omit<FlyAiCallProof, "rawItemCount">,
): DiscoverCategoryResult {
  let payload: PoiEnvelope;
  try {
    payload = JSON.parse(stdout) as PoiEnvelope;
  } catch (error) {
    return {
      category,
      items: [],
      proof: { ...proof, rawItemCount: 0 },
      error: `flyai 输出不是合法 JSON：${(error as Error).message}；输出开头：${tail(stdout, 200)}`,
    };
  }

  if (payload.status !== 0) {
    return {
      category,
      items: [],
      proof: { ...proof, rawItemCount: 0 },
      error: `飞猪返回非成功状态：status=${payload.status} message=${payload.message ?? "无"}${
        payload.systemMessage ? ` systemMessage=${payload.systemMessage}` : ""
      }`,
    };
  }

  const rawList = Array.isArray(payload.data?.itemList) ? (payload.data?.itemList ?? []) : [];
  const items = rawList.flatMap((raw, index) => {
    const poi = toDiscoveredPoi(raw, category, index, proof.invokedAt);
    return poi ? [poi] : [];
  });
  const fullProof: FlyAiCallProof = { ...proof, rawItemCount: rawList.length };

  if (!items.length) {
    return {
      category,
      items: [],
      proof: fullProof,
      error: rawList.length
        ? `飞猪返回 ${rawList.length} 条数据，但全部缺少 name 字段，已丢弃。`
        : "飞猪返回成功但 itemList 为空，该类别在杭州可能没有收录。",
    };
  }
  return { category, items, proof: fullProof, error: null };
}

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** 只接受 http(s) 链接，避免把 javascript: 之类的值渲染成可点击地址。 */
function toHttpUrl(value: unknown): string | null {
  const text = toText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** 飞猪把经纬度当字符串返回，这里统一转数字并做合法性校验。 */
function toLatLng(latitude: unknown, longitude: unknown): LatLng | null {
  const latText = toText(latitude);
  const lngText = toText(longitude);
  if (!latText || !lngText) return null;
  const lat = Number(latText);
  const lng = Number(lngText);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function toDiscoveredPoi(
  raw: unknown,
  category: string,
  index: number,
  collectedAt: string,
): DiscoveredPoi | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = toText(record.name);
  if (!name) return null;

  const missingFields: DiscoveredPoiMissingField[] = [];
  const id = toText(record.id);
  const address = toText(record.address);
  const poiCategory = toText(record.category);
  const position = toLatLng(record.latitude, record.longitude);
  const jumpUrl = toHttpUrl(record.jumpUrl);
  const description = toText(record.description);

  if (!id) missingFields.push("id");
  if (!address) missingFields.push("address");
  // 不用查询类别去补数据缺失，缺就明确标出来
  if (!poiCategory) missingFields.push("category");
  if (!position) missingFields.push("position");
  if (!jumpUrl) missingFields.push("jumpUrl");
  if (!description) missingFields.push("description");

  return {
    id: id ?? `flyai-${category}-${index}`,
    name,
    address,
    category: poiCategory,
    position,
    coordinatesVerified: false,
    jumpUrl,
    description,
    source: "live",
    missingFields,
    // 缓存命中时 items 原样复用，这个时间仍是原始采集时间，不会因复用被刷新
    collectedAt,
  };
}
