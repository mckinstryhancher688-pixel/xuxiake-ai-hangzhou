import { haversineMeters, wgs84ToGcj02 } from "@/lib/geo";
import type {
  AmapCallLogEntry,
  AmapPoi,
  AmapUsage,
  CandidateMatch,
  DatumConclusion,
  DatumProbe,
  DiscoveredPoi,
  FlyAiCallProof,
  LatLng,
  OpeningStatus,
  RouteStart,
  VerifiedItinerary,
  VerifiedStop,
  VerifyReport,
  WalkingLeg,
} from "@/lib/types";
import {
  BUFFER_MINUTES,
  BUDGET_MINUTES,
  DATUM_DECISIVE_METERS,
  DEFAULT_VERIFY_CATEGORIES,
  DEVIATION_SUSPECT_METERS,
  MAX_STOPS,
  MAX_STRAIGHT_LINE_METERS,
  MIN_STOPS,
  SHORTLIST_SIZE,
  SIMULATED_STAY_MINUTES,
  START_KEYWORD,
  VERIFY_DISTRICT,
  assumedTripWindow,
  isWindowClosed,
  parseOpeningWindows,
  type AmapServerStatus,
} from "@/lib/verification";
import {
  amapCounters,
  maskAmapKey,
  planWalking,
  readAmapKey,
  searchPlace,
} from "./amap";
import { discoverCity } from "./discover";
import { buildFactSet, mintFactsId, putFactSet } from "./facts";
import { composeItinerary, toLeg } from "@/lib/itinerary-compose";
import type { FlyAiPoiCategory } from "@/lib/discovery";

if (typeof window !== "undefined") {
  throw new Error("lib/server/verify 只能在 Next.js 服务端加载。");
}

/** 整条流水线的结果缓存：重复点「校验路线」不再触发任何真实请求。 */
const PIPELINE_CACHE_TTL_MS = 30 * 60 * 1000;
/** 只负责喂饱 amap.ts 里的串行闸门；真正的限速（≈2.5 QPS）在那边统一做。 */
const CONCURRENCY = 3;

const START_KEY = "__start__";

interface PipelineCacheEntry {
  at: number;
  report: VerifyReport;
}

const pipelineCache = new Map<string, PipelineCacheEntry>();
const pipelineInflight = new Map<string, Promise<VerifyReport>>();

export async function verifyRoute(
  cityName: string,
  categories: FlyAiPoiCategory[] = DEFAULT_VERIFY_CATEGORIES,
): Promise<VerifyReport> {
  const cacheKey = `${cityName}|${categories.join(",")}`;
  const hit = pipelineCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PIPELINE_CACHE_TTL_MS) return hit.report;

  const pending = pipelineInflight.get(cacheKey);
  if (pending) return pending;

  const task = runPipeline(cityName, categories);
  pipelineInflight.set(cacheKey, task);
  try {
    const report = await task;
    // 只缓存跑通的流水线；失败要允许立刻重试
    if (report.ok) pipelineCache.set(cacheKey, { at: Date.now(), report });
    return report;
  } finally {
    pipelineInflight.delete(cacheKey);
  }
}

/** GET /api/verify 的返回体，用来在页面上证明高德调用确实发生在服务端。 */
export function amapServerStatus(): AmapServerStatus {
  const counters = amapCounters();
  return {
    keyPresent: counters.keyPresent,
    keyMask: counters.keyMask,
    placeHourlyUsed: counters.placeCalls,
    placeHourlyCap: counters.placeHourlyCap,
    walkingHourlyUsed: counters.walkingCalls,
    walkingHourlyCap: counters.walkingHourlyCap,
    cacheTtlSeconds: counters.cacheTtlSeconds,
    cacheEntries: counters.cacheEntries,
    pipelineCacheTtlSeconds: PIPELINE_CACHE_TTL_MS / 1000,
    budgetMinutes: BUDGET_MINUTES,
    simulatedStayMinutes: SIMULATED_STAY_MINUTES,
    bufferMinutes: BUFFER_MINUTES,
    deviationSuspectMeters: DEVIATION_SUSPECT_METERS,
    categories: [...DEFAULT_VERIFY_CATEGORIES],
    startKeyword: START_KEYWORD,
    serverTime: new Date().toISOString(),
    pid: process.pid,
  };
}

async function runPipeline(
  cityName: string,
  categories: FlyAiPoiCategory[],
): Promise<VerifyReport> {
  const generatedAt = new Date().toISOString();
  const log: AmapCallLogEntry[] = [];
  const flyaiProofs: FlyAiCallProof[] = [];

  const base = {
    cityName,
    districtName: VERIFY_DISTRICT,
    budgetMinutes: BUDGET_MINUTES,
    generatedAt,
    categories: [...categories],
  };

  if (!readAmapKey()) {
    return fail(
      base,
      log,
      flyaiProofs,
      "服务端没有读到 AMAP_WEB_KEY，已拒绝发起任何高德调用（不会用演示结果冒充真实核验）。请在项目根目录 .env.local 写入 AMAP_WEB_KEY 后重试。",
    );
  }

  /* 1. 取飞猪真实候选。走 discoverCity 复用第二阶段的缓存与调用上限。 */
  const batch = await discoverCity(cityName, [...categories]);
  for (const result of batch.results) {
    if (result.proof) flyaiProofs.push(result.proof);
  }
  if (!batch.ok) {
    return fail(base, log, flyaiProofs, `飞猪候选获取失败，无法核验：${batch.error ?? "未知错误"}`);
  }

  const candidates = dedupeByName(batch.results.flatMap((result) => result.items));
  if (!candidates.length) {
    return fail(base, log, flyaiProofs, "飞猪返回了成功状态但没有任何候选地点。");
  }

  /* 2. 固定起点：湖滨附近一个能被高德核实的具体地点。 */
  const startResult = await searchPlace(START_KEYWORD, { region: cityName, pageSize: 10 });
  log.push(startResult.entry);
  if (!startResult.ok || !startResult.data?.length) {
    return fail(
      base,
      log,
      flyaiProofs,
      `高德 POI 搜索没能确定起点「${START_KEYWORD}」：${startResult.error ?? "返回 0 条"}`,
    );
  }
  const start = pickStart(startResult.data);

  /* 3. 每个候选做一次高德 POI 搜索，按名称/地址/行政区比对。 */
  const placeResults = await mapLimit(candidates, CONCURRENCY, async (candidate) => {
    const result = await searchPlace(candidate.name, { region: cityName, pageSize: 10 });
    log.push(result.entry);
    return { candidate, result };
  });

  const preliminary = placeResults.map(({ candidate, result }) =>
    compareCandidate(candidate, result.ok ? result.data : null, result.error),
  );

  /* 4. 坐标系判定：用同名地标比对「飞猪原样」与「飞猪当 WGS-84 转换后」两种假设。 */
  const datum = concludeDatum(preliminary);

  /* 5. 按判定出的坐标系给出偏差与匹配状态。 */
  const matches = preliminary.map((item) => applyDatum(item, datum));
  const matchedCount = matches.filter((m) => m.status === "matched").length;
  const suspiciousCount = matches.filter((m) => m.status === "suspicious").length;
  const unverifiedCount = matches.filter((m) => m.status === "unverified").length;
  const routable = matches.filter((m) => m.routable && m.routablePosition);
  const rejections: { name: string; reason: string }[] = [];
  /** 高德明确「没有路线」的有向段；与「从没测过」严格区分，见 facts.ts */
  const failedPairKeys: string[] = [];
  for (const match of matches.filter((m) => !m.routable)) {
    rejections.push({ name: match.name, reason: match.routableReason || match.reason || "未通过地理核验" });
  }

  if (!start) {
    return fail(base, log, flyaiProofs, "起点未能确定。");
  }
  if (routable.length < MIN_STOPS) {
    return {
      ...base,
      ok: false,
      error: null,
      candidateCount: candidates.length,
      datum,
      start,
      matches,
      matchedCount,
      suspiciousCount,
      unverifiedCount,
      routableCount: routable.length,
      itinerary: null,
      insufficiency: `通过地理核验的地点只有 ${routable.length} 个，少于组成一条行程所需的 ${MIN_STOPS} 个。这里不会用未经核验或虚构的地点凑数。`,
      rejections,
      amap: usage(log),
      flyaiProofs,
    };
  }

  /* 6. 起点→每个已核验候选的真实步行距离与耗时（不用直线距离替代）。 */
  const fromStart = await mapLimit(routable, CONCURRENCY, async (match) => {
    const position = match.routablePosition as LatLng;
    const straight = haversineMeters(start.position, position);
    if (straight > MAX_STRAIGHT_LINE_METERS) {
      return { match, leg: null, skipped: `直线距离 ${(straight / 1000).toFixed(1)} 公里，超过 ${MAX_STRAIGHT_LINE_METERS / 1000} 公里上限，四小时往返不可能，未消耗路径规划调用` };
    }
    const result = await planWalking(start.position, position);
    log.push(result.entry);
    if (!result.ok || !result.data) {
      failedPairKeys.push(`${START_KEY}->${match.flyaiId}`);
      return { match, leg: null, skipped: `高德步行路径规划失败：${result.error ?? "无路线"}` };
    }
    return { match, leg: toLeg(start.name, match.name, start.position, position, result.data, result.entry.fromCache), skipped: null };
  });

  const reachable = fromStart.filter((item): item is { match: CandidateMatch; leg: WalkingLeg; skipped: null } => item.leg !== null);
  for (const item of fromStart.filter((entry) => entry.skipped)) {
    rejections.push({ name: item.match.name, reason: item.skipped as string });
  }

  if (reachable.length < MIN_STOPS) {
    return {
      ...base,
      ok: false,
      error: null,
      candidateCount: candidates.length,
      datum,
      start,
      matches,
      matchedCount,
      suspiciousCount,
      unverifiedCount,
      routableCount: routable.length,
      itinerary: null,
      insufficiency: `地理核验通过 ${routable.length} 个，但只有 ${reachable.length} 个能算出真实步行路线，少于 ${MIN_STOPS} 个，无法组成行程。`,
      rejections,
      amap: usage(log),
      flyaiProofs,
    };
  }

  /* 7. 按真实步行耗时取最近的若干个，再测两两之间的真实步行路线。 */
  const shortlist = [...reachable].sort((a, b) => a.leg.durationMinutes - b.leg.durationMinutes).slice(0, SHORTLIST_SIZE);
  for (const item of reachable.filter((entry) => !shortlist.includes(entry))) {
    rejections.push({
      name: item.match.name,
      reason: `从起点步行 ${item.leg.durationMinutes} 分钟（${item.leg.distanceMeters} 米），不在最近的 ${SHORTLIST_SIZE} 个之内，未进入组合计算`,
    });
  }

  const pairLegs = new Map<string, WalkingLeg>();
  for (const item of shortlist) pairLegs.set(`${START_KEY}->${item.match.flyaiId}`, item.leg);

  const pairTasks: { from: ShortlistItem; to: ShortlistItem }[] = [];
  for (const from of shortlist) {
    for (const to of shortlist) {
      if (from.match.flyaiId !== to.match.flyaiId) pairTasks.push({ from, to });
    }
  }
  await mapLimit(pairTasks, CONCURRENCY, async ({ from, to }) => {
    const fromPosition = from.match.routablePosition as LatLng;
    const toPosition = to.match.routablePosition as LatLng;
    const result = await planWalking(fromPosition, toPosition);
    log.push(result.entry);
    if (result.ok && result.data) {
      pairLegs.set(
        `${from.match.flyaiId}->${to.match.flyaiId}`,
        toLeg(from.match.name, to.match.name, fromPosition, toPosition, result.data, result.entry.fromCache),
      );
    } else {
      failedPairKeys.push(`${from.match.flyaiId}->${to.match.flyaiId}`);
      rejections.push({
        name: `${from.match.name} → ${to.match.name}`,
        reason: `高德步行路径规划失败：${result.error ?? "无路线"}，含这一段的组合已被排除`,
      });
    }
    return null;
  });

  /* 8. 营业时间：高德给了时间且整段行程都落在外面，才算「确认冲突」。 */
  const tripWindow = assumedTripWindow(new Date());
  const conflicted = new Set<string>();
  for (const item of shortlist) {
    const opening = evaluateOpening(item.match, tripWindow.startMinutes, tripWindow.endMinutes);
    item.match.openingStatus = opening.status;
    item.match.openingNote = opening.note;
    if (opening.status === "conflict") {
      conflicted.add(item.match.flyaiId);
      rejections.push({ name: item.match.name, reason: opening.note });
    }
  }

  const pool = shortlist.filter((item) => !conflicted.has(item.match.flyaiId));
  if (pool.length < MIN_STOPS) {
    return {
      ...base,
      ok: false,
      error: null,
      candidateCount: candidates.length,
      datum,
      start,
      matches,
      matchedCount,
      suspiciousCount,
      unverifiedCount,
      routableCount: routable.length,
      itinerary: null,
      insufficiency: `排除营业时间确认冲突的地点后只剩 ${pool.length} 个，少于 ${MIN_STOPS} 个。`,
      rejections,
      amap: usage(log),
      flyaiProofs,
    };
  }

  /* 9. 穷举 3~4 站的有序组合，用真实步行耗时挑出四小时内最充实的一条。 */
  const chosen = pickBestChain(pool, pairLegs);
  if (!chosen) {
    return {
      ...base,
      ok: false,
      error: null,
      candidateCount: candidates.length,
      datum,
      start,
      matches,
      matchedCount,
      suspiciousCount,
      unverifiedCount,
      routableCount: routable.length,
      itinerary: null,
      insufficiency: `${pool.length} 个已核验地点的所有 ${MIN_STOPS}~${MAX_STOPS} 站组合，加上模拟停留 ${SIMULATED_STAY_MINUTES} 分钟/站与 ${BUFFER_MINUTES} 分钟余量后都超过 ${BUDGET_MINUTES} 分钟。这里不会缩短真实步行时间来凑数。`,
      rejections,
      amap: usage(log),
      flyaiProofs,
    };
  }

  for (const item of pool.filter((entry) => !chosen.items.includes(entry))) {
    rejections.push({
      name: item.match.name,
      reason: "组合可行，但不是四小时内最优顺序（已选出总耗时更短的组合）",
    });
  }

  const itinerary = buildItinerary(chosen, start, tripWindow.startAt);

  /* 事实层入库：把这次已经付费测出的全部有向段留下，供双人协商本地重解。 */
  const measuredLegs = new Map(pairLegs);
  for (const item of reachable) {
    const key = `${START_KEY}->${item.match.flyaiId}`;
    if (!measuredLegs.has(key)) measuredLegs.set(key, item.leg);
  }
  const facts = buildFactSet({
    factsId: mintFactsId(),
    cityName,
    categories,
    start,
    matches,
    legs: measuredLegs,
    failedKeys: failedPairKeys,
  });

  return {
    ...base,
    ok: true,
    error: null,
    candidateCount: candidates.length,
    datum,
    start,
    matches,
    matchedCount,
    suspiciousCount,
    unverifiedCount,
    routableCount: routable.length,
    itinerary,
    insufficiency: null,
    rejections,
    amap: usage(log),
    flyaiProofs,
    facts: putFactSet(facts),
  };
}

function fail(
  base: Pick<VerifyReport, "cityName" | "districtName" | "budgetMinutes" | "generatedAt" | "categories">,
  log: AmapCallLogEntry[],
  flyaiProofs: FlyAiCallProof[],
  error: string,
): VerifyReport {
  console.error(`[amap] 核验失败：${error}`);
  return {
    ...base,
    ok: false,
    error,
    candidateCount: 0,
    datum: { probes: [], flyaiDatum: null, reason: "流程在坐标系判定之前就失败了" },
    start: null,
    matches: [],
    matchedCount: 0,
    suspiciousCount: 0,
    unverifiedCount: 0,
    routableCount: 0,
    itinerary: null,
    insufficiency: null,
    rejections: [],
    amap: usage(log),
    flyaiProofs,
  };
}

function usage(log: AmapCallLogEntry[]): AmapUsage {
  const counters = amapCounters();
  return {
    keyPresent: Boolean(readAmapKey()),
    keyMask: maskAmapKey(readAmapKey()),
    placeCalls: log.filter((entry) => entry.api === "place/text" && !entry.fromCache).length,
    walkingCalls: log.filter((entry) => entry.api === "direction/walking" && !entry.fromCache).length,
    cacheHits: log.filter((entry) => entry.fromCache).length,
    failedCalls: log.filter((entry) => entry.error).length,
    placeHourlyCap: counters.placeHourlyCap,
    walkingHourlyCap: counters.walkingHourlyCap,
    cacheTtlSeconds: counters.cacheTtlSeconds,
    log,
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function dedupeByName(items: DiscoveredPoi[]): DiscoveredPoi[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = normalizeName(item.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ── 名称 / 地址 / 行政区比对 ─────────────────────────────────────── */

const NAME_NOISE = /[\s·・\-—–()（）[\]【】.,，。]/g;

function normalizeName(name: string): string {
  return name.replace(NAME_NOISE, "").toLowerCase();
}

const HANGZHOU_DISTRICTS = [
  "西湖区", "上城区", "拱墅区", "滨江区", "萧山区", "余杭区",
  "临平区", "钱塘区", "富阳区", "临安区", "桐庐县", "淳安县", "建德市",
];

function extractDistrict(text: string | null): string | null {
  if (!text) return null;
  return HANGZHOU_DISTRICTS.find((district) => text.includes(district)) ?? null;
}

/**
 * 高德类型码里可以代表「地点本体」的一级类目：
 * 06 购物服务（商业街）、08 体育休闲、11 风景名胜、12 商务住宅（园区）、
 * 14 科教文化（博物馆/纪念馆）、19 地名地址（街区/道路/村落）、20 公共设施。
 * 其余（05 餐饮、10 住宿、07 生活服务、15 交通设施、18 道路附属…）即使名字里
 * 带上了景点名，也不是景点本体——实测搜「小河直街」会先返回「与河餐厅(小河直街店)」。
 * 高德允许一个 POI 带多个类型码（用 "|" 分隔），任一段命中即算。
 */
const PLACE_TYPECODE_PREFIXES = ["06", "08", "11", "12", "14", "19", "20"];

function isPlausiblePlace(poi: AmapPoi): boolean {
  if (!poi.typecode) return false;
  return poi.typecode
    .split("|")
    .some((code) => PLACE_TYPECODE_PREFIXES.some((prefix) => code.startsWith(prefix)));
}

interface PreliminaryMatch {
  match: CandidateMatch;
  /** 名称是否完全一致，用来挑选坐标系判定的地标样本 */
  nameExact: boolean;
  /** 高德只匹配到类型不符的 POI（餐厅/停车场/车站等），不是地点本体 */
  offType: boolean;
  asGcj02Meters: number | null;
  asWgs84Meters: number | null;
}

function compareCandidate(
  candidate: DiscoveredPoi,
  amapPois: AmapPoi[] | null,
  amapError: string | null,
): PreliminaryMatch {
  const flyaiDistrict = extractDistrict(candidate.address);
  const base = {
    flyaiId: candidate.id,
    name: candidate.name,
    category: candidate.category,
    flyaiAddress: candidate.address,
    flyaiPosition: candidate.position,
    jumpUrl: candidate.jumpUrl,
    flyaiDescription: candidate.description ?? null,
    deviationMeters: null,
    routablePosition: null,
    nameAgrees: null,
    addressAgrees: null,
    districtAgrees: null,
    openingStatus: "unknown" as OpeningStatus,
    openingNote: "高德未返回该地点的营业时间，无法核实",
  };

  if (!amapPois) {
    return {
      match: {
        ...base,
        status: "unverified",
        reason: `高德 POI 搜索失败：${amapError ?? "无返回"}`,
        amap: null,
        routable: false,
        routableReason: "高德侧没有可用坐标，不能参与已验证路线规划",
      },
      nameExact: false,
      offType: false,
      asGcj02Meters: null,
      asWgs84Meters: null,
    };
  }
  if (!amapPois.length) {
    return {
      match: {
        ...base,
        status: "unverified",
        reason: `高德在杭州范围内搜不到名称含「${candidate.name}」的 POI`,
        amap: null,
        routable: false,
        routableReason: "身份无法确认，不能参与已验证路线规划",
      },
      nameExact: false,
      offType: false,
      asGcj02Meters: null,
      asWgs84Meters: null,
    };
  }

  const target = normalizeName(candidate.name);
  const overlaps = (poi: AmapPoi) => {
    const name = normalizeName(poi.name);
    return target.length >= 2 && (name.includes(target) || target.includes(name));
  };

  // 高德搜「平湖秋月」会把「平湖秋月停车场」一起返回，搜「小河直街」会先返回
  // 「与河餐厅(小河直街店)」；这些都不是地点本体，优先挑类型码对得上的。
  const exact = amapPois.find((poi) => normalizeName(poi.name) === target) ?? null;
  const scenic = exact ?? amapPois.find((poi) => overlaps(poi) && isPlausiblePlace(poi)) ?? null;
  const fallback = scenic ?? amapPois.find((poi) => overlaps(poi)) ?? null;
  const chosen = scenic ?? fallback;

  if (!chosen) {
    return {
      match: {
        ...base,
        status: "unverified",
        reason: `高德返回 ${amapPois.length} 条结果，但名称都对不上（最接近的是「${amapPois[0].name}」）`,
        amap: null,
        nameAgrees: false,
        routable: false,
        routableReason: "名称比对失败，身份无法确认",
      },
      nameExact: false,
      offType: false,
      asGcj02Meters: null,
      asWgs84Meters: null,
    };
  }

  const nameExact = Boolean(exact);
  const offType = !scenic;
  const amapDistrict = chosen.adname;
  const districtAgrees =
    flyaiDistrict && amapDistrict ? flyaiDistrict === amapDistrict : null;
  const addressAgrees = compareAddress(candidate.address, chosen.address);

  const asGcj02Meters = candidate.position
    ? Math.round(haversineMeters(candidate.position, chosen.position))
    : null;
  const asWgs84Meters = candidate.position
    ? Math.round(haversineMeters(wgs84ToGcj02(candidate.position), chosen.position))
    : null;

  const match: CandidateMatch = {
    ...base,
    status: "unverified",
    reason: null,
    amap: chosen,
    nameAgrees: nameExact,
    addressAgrees,
    districtAgrees,
    routablePosition: chosen.position,
    routable: false,
    routableReason: "",
    openingStatus: "unknown",
    openingNote: chosen.opentime
      ? `高德返回营业时间「${chosen.opentime}」，是否与行程窗口冲突见下方判定`
      : "高德未返回该地点的营业时间，无法核实",
  };

  return { match, nameExact, offType, asGcj02Meters, asWgs84Meters };
}

function compareAddress(flyaiAddress: string | null, amapAddress: string | null): boolean | null {
  if (!flyaiAddress || !amapAddress) return null;
  const a = flyaiAddress.replace(NAME_NOISE, "");
  const b = amapAddress.replace(NAME_NOISE, "");
  if (!a || !b) return null;
  return a.includes(b) || b.includes(a);
}

/* ── 坐标系判定 ──────────────────────────────────────────────────── */

function concludeDatum(items: PreliminaryMatch[]): DatumConclusion {
  const samples = items
    .filter((item) => item.nameExact && item.asGcj02Meters !== null && item.asWgs84Meters !== null)
    .slice(0, 3);

  if (samples.length < 2) {
    return {
      probes: samples.map(toProbe),
      flyaiDatum: null,
      reason: `只有 ${samples.length} 个「飞猪与高德同名且双方都有坐标」的地标可用于比对，不足 2 个，无法判定飞猪用的是哪个坐标系。`,
    };
  }

  const probes = samples.map(toProbe);
  const meanGcj = average(probes.map((probe) => probe.asGcj02Meters));
  const meanWgs = average(probes.map((probe) => probe.asWgs84Meters));
  const detail = `样本 ${probes.map((p) => p.landmarkName).join("、")}：把飞猪坐标当 GCJ-02 直接比对，平均偏差 ${meanGcj.toFixed(0)} 米；把飞猪坐标当 WGS-84 转成 GCJ-02 再比对，平均偏差 ${meanWgs.toFixed(0)} 米。`;

  if (meanGcj + DATUM_DECISIVE_METERS <= meanWgs) {
    return {
      probes,
      flyaiDatum: "gcj02",
      reason: `${detail}两种假设相差 ${(meanWgs - meanGcj).toFixed(0)} 米，证据支持飞猪用的就是 GCJ-02（与高德一致），无需转换。`,
    };
  }
  if (meanWgs + DATUM_DECISIVE_METERS <= meanGcj) {
    return {
      probes,
      flyaiDatum: "wgs84",
      reason: `${detail}两种假设相差 ${(meanGcj - meanWgs).toFixed(0)} 米，证据支持飞猪用的是 WGS-84，比对前已转换为 GCJ-02。`,
    };
  }
  return {
    probes,
    flyaiDatum: null,
    reason: `${detail}两者只差 ${Math.abs(meanWgs - meanGcj).toFixed(0)} 米（小于 ${DATUM_DECISIVE_METERS} 米判定阈值），证据不足以断定坐标系。`,
  };
}

function toProbe(item: PreliminaryMatch): DatumProbe {
  return {
    landmarkName: item.match.name,
    flyaiPosition: item.match.flyaiPosition as LatLng,
    amapPosition: (item.match.amap as AmapPoi).position,
    asGcj02Meters: item.asGcj02Meters as number,
    asWgs84Meters: item.asWgs84Meters as number,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
}

/** 依据判定结果把 preliminary 收敛成最终状态；坐标系没判定时取两种假设里更小的偏差，并写明。 */
function applyDatum(item: PreliminaryMatch, datum: DatumConclusion): CandidateMatch {
  const match = { ...item.match };
  if (!match.amap) return match;

  const { asGcj02Meters, asWgs84Meters } = item;
  if (asGcj02Meters === null || asWgs84Meters === null) {
    // 飞猪没给坐标：身份靠名称+行政区确认，位置直接采用高德返回值
    match.deviationMeters = null;
    match.status = "suspicious";
    match.reason = "飞猪未返回坐标，无法比对偏差；位置采用高德返回值";
    match.routable = item.nameExact && match.districtAgrees !== false;
    match.routableReason = match.routable
      ? "名称与高德完全一致且行政区不冲突，位置取自高德"
      : "飞猪缺坐标且名称/行政区无法互相印证";
    return match;
  }

  const useConverted = datum.flyaiDatum === "wgs84";
  const deviation = useConverted ? asWgs84Meters : asGcj02Meters;
  const other = useConverted ? asGcj02Meters : asWgs84Meters;
  match.deviationMeters = datum.flyaiDatum === null ? Math.min(deviation, other) : deviation;

  const datumNote =
    datum.flyaiDatum === null
      ? `坐标系未能判定，偏差取两种假设中较小值（GCJ-02 假设 ${asGcj02Meters} 米 / WGS-84 假设 ${asWgs84Meters} 米）`
      : `按判定的 ${datum.flyaiDatum.toUpperCase()} 比对`;

  if (match.districtAgrees === false) {
    match.status = "suspicious";
    match.reason = `行政区不一致：飞猪地址指向「${extractDistrict(match.flyaiAddress)}」，高德为「${match.amap.adname}」，可能是同名异地`;
    match.routable = false;
    match.routableReason = "行政区冲突，身份不确定，不参与已验证路线规划";
    return match;
  }

  if (!item.nameExact) {
    match.status = "suspicious";
    match.reason = item.offType
      ? `高德只匹配到类型不符的「${match.amap.name}」（类型码 ${match.amap.typecode ?? "缺失"}），不是地点本体；${datumNote}偏差 ${match.deviationMeters} 米`
      : `仅名称包含匹配（高德为「${match.amap.name}」），不是完全同名；${datumNote}偏差 ${match.deviationMeters} 米`;
    // 餐厅/停车场/车站不能代替地点本体，否则步行终点会落在错误的地方
    match.routable =
      !item.offType &&
      match.districtAgrees === true &&
      match.deviationMeters <= DEVIATION_SUSPECT_METERS;
    match.routableReason = match.routable
      ? "名称部分匹配但行政区一致且坐标吻合，采用高德坐标参与规划"
      : item.offType
        ? "只匹配到餐厅/停车场/车站这类类型不符的 POI，步行终点会落错地方"
        : "名称只是部分匹配，身份不够确定";
    return match;
  }

  if (match.deviationMeters <= DEVIATION_SUSPECT_METERS) {
    match.status = "matched";
    match.reason = `名称完全一致，${datumNote}偏差 ${match.deviationMeters} 米（阈值 ${DEVIATION_SUSPECT_METERS} 米内）`;
    match.routable = true;
    match.routableReason = "名称、坐标均已与高德互相印证";
    return match;
  }

  // 偏差大不等于错：大型景区不同入口本来就有几百米差，所以只标可疑
  match.status = "suspicious";
  match.reason = `名称完全一致，但${datumNote}偏差 ${match.deviationMeters} 米，超过 ${DEVIATION_SUSPECT_METERS} 米。这不代表飞猪数据错误——大型景区不同入口/观景平台本来就有几百米落差；路线一律采用高德坐标。`;
  match.routable = true;
  match.routableReason = "身份由名称确认，坐标偏差只说明飞猪标点较粗，路线使用高德坐标";
  return match;
}

/* ── 起点与营业时间 ─────────────────────────────────────────────── */

const PARK_TYPECODES = ["1101", "1102", "1100"];

function pickStart(pois: AmapPoi[]): RouteStart | null {
  const named = pois.filter((poi) => poi.name.includes(START_KEYWORD));
  const chosen =
    named.find((poi) => PARK_TYPECODES.some((code) => poi.typecode?.startsWith(code))) ??
    named[0] ??
    null;
  if (!chosen) return null;
  return {
    name: chosen.name,
    amapId: chosen.id,
    address: chosen.address,
    position: chosen.position,
    reason: `高德 POI 搜索「${START_KEYWORD}」（限杭州）返回 ${pois.length} 条，取名称含关键词且类型为风景名胜/公园的第一条；坐标为高德实测值，作为四小时步行路线的固定起点。`,
  };
}

function evaluateOpening(
  match: CandidateMatch,
  startMinutes: number,
  endMinutes: number,
): { status: OpeningStatus; note: string } {
  const windows = parseOpeningWindows(match.amap?.opentime ?? null);
  if (!windows) {
    return {
      status: "unknown",
      note: match.amap?.opentime
        ? `高德返回「${match.amap.opentime}」，但格式无法解析，按待核实处理，不做假设`
        : "高德未返回营业时间，待核实",
    };
  }
  if (windows.length === 1 && windows[0][0] === 0 && windows[0][1] === 24 * 60) {
    return { status: "open-24h", note: `高德：${match.amap?.opentime}，全天开放，无冲突` };
  }
  if (isWindowClosed(windows, startMinutes, endMinutes)) {
    return {
      status: "conflict",
      note: `确认冲突：高德营业时间「${match.amap?.opentime}」，而假定行程窗口是 ${formatMinutes(startMinutes)}–${formatMinutes(endMinutes)}，整段都在营业时间外`,
    };
  }
  return { status: "no-conflict", note: `高德：${match.amap?.opentime}，与假定行程窗口 ${formatMinutes(startMinutes)}–${formatMinutes(endMinutes)} 有交集` };
}

function formatMinutes(minutes: number): string {
  const clamped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

/* ── 组合寻优与行程装配 ─────────────────────────────────────────── */

interface ShortlistItem {
  match: CandidateMatch;
  leg: WalkingLeg;
  skipped: null;
}

interface Chain {
  items: ShortlistItem[];
  legs: WalkingLeg[];
  totalMinutes: number;
}

function pickBestChain(pool: ShortlistItem[], pairLegs: Map<string, WalkingLeg>): Chain | null {
  let best: Chain | null = null;
  for (let size = MAX_STOPS; size >= MIN_STOPS; size -= 1) {
    for (const combo of permutations(pool, size)) {
      const legs: WalkingLeg[] = [];
      let walkMinutes = 0;
      let previous = START_KEY;
      let complete = true;
      for (const item of combo) {
        const leg = pairLegs.get(`${previous}->${item.match.flyaiId}`);
        if (!leg) {
          complete = false;
          break;
        }
        legs.push(leg);
        walkMinutes += leg.durationMinutes;
        previous = item.match.flyaiId;
      }
      if (!complete) continue;

      const totalMinutes =
        walkMinutes + combo.length * SIMULATED_STAY_MINUTES + BUFFER_MINUTES;
      if (totalMinutes > BUDGET_MINUTES) continue;

      const chain: Chain = { items: combo, legs, totalMinutes };
      // 站数多的优先；站数相同再比总耗时
      if (!best || combo.length > best.items.length || totalMinutes < best.totalMinutes) {
        best = chain;
      }
    }
    if (best && best.items.length === size) return best;
  }
  return best;
}

function permutations<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  const walk = (picked: T[], remaining: T[]) => {
    if (picked.length === size) {
      output.push([...picked]);
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      walk([...picked, remaining[index]], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
    }
  };
  walk([], items);
  return output;
}

function buildItinerary(
  chain: Chain,
  start: RouteStart,
  assumedStart: Date,
): VerifiedItinerary {
  const stops: VerifiedStop[] = chain.items.map((item) => ({
    name: item.match.name,
    flyaiId: item.match.flyaiId,
    amapId: item.match.amap?.id ?? "",
    address: item.match.amap?.address ?? null,
    position: item.match.routablePosition as LatLng,
    matchStatus: item.match.status,
    stayMinutes: SIMULATED_STAY_MINUTES,
    staySource: "simulated",
    openingStatus: item.match.openingStatus,
    openingNote: item.match.openingNote,
    jumpUrl: item.match.jumpUrl,
    flyaiDescription: item.match.flyaiDescription,
  }));

  return composeItinerary(start, stops, chain.legs, assumedStart);
}
