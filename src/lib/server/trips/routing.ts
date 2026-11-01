import { searchPlace, planWalking, withAmapBudget, type AmapCallResult, type AmapWalkingData } from "../amap";
import { discoverCity } from "../discover";
import { evaluateOpening, isPlausiblePlace, compareVerifiedPoiPairs } from "../verify";
import { assumedTripWindow, SIMULATED_STAY_MINUTES, MAX_STRAIGHT_LINE_METERS } from "@/lib/verification";
import { FLYAI_POI_CATEGORIES, type FlyAiPoiCategory } from "@/lib/discovery";
import { FACT_START_KEY, type FactSet, type PartyConditions } from "@/lib/negotiation/types";
import { estimateMissingEdges } from "@/lib/negotiation/solve";
import { haversineMeters } from "@/lib/geo";
import { toLeg } from "@/lib/itinerary-compose";
import { LIMITS, type PoiCandidate, type TripJob, type TripWorkspace, type VerifyQuote } from "@/lib/trips/types";
import type { AmapPoi, CandidateMatch, LatLng, DiscoverBatch } from "@/lib/types";
import { charge, evidence, hash, id, loadTrip, mutate, putEvidence, TripError } from "./db";
import { factsFresh, solveTrip, suspend } from "./store";

const TTL = 6 * 3600000;
export interface RouteProviders {
  place(name: string): Promise<AmapCallResult<AmapPoi[]>>;
  walk(from: LatLng, to: LatLng): Promise<AmapCallResult<AmapWalkingData>>;
}
const realRoutes: RouteProviders = {
  place: (name) => searchPlace(name, { region: "杭州", cityLimit: true, pageSize: 10 }),
  walk: planWalking,
};
function signature(trip: TripWorkspace): string {
  return hash(JSON.stringify([trip.members.B?.joinedAt ?? null, trip.conditions,
    trip.candidates.filter((c) => c.selected).map((c) => [c.id, c.name, c.amap?.id]), trip.plan?.headRevision]));
}
function workingCandidates(trip: TripWorkspace): PoiCandidate[] {
  const ids = new Set(trip.candidates.filter((c) => c.selected).map((c) => c.id));
  for (const party of [trip.conditions.A, trip.conditions.B]) {
    if (!party) continue;
    for (const key of party.hard.mustVisit) ids.add(key);
    for (const [key, rank] of Object.entries(party.soft)) if (rank === "prefer") ids.add(key);
  }
  if (!ids.size) throw new TripError(400, "请先挑选要比较的地点。");
  if (ids.size > LIMITS.candidates) throw new TripError(422, "本轮最多比较六个地点；请保留双方必须去和特别想去的地点后主动缩减。");
  const must = new Set([trip.conditions.A, trip.conditions.B].flatMap((c) => c?.hard.mustVisit ?? []));
  const never = new Set([trip.conditions.A, trip.conditions.B].flatMap((c) => c?.hard.neverAccept ?? []));
  if ([...must].some((key) => never.has(key))) throw new TripError(422, "一方必须去与另一方绝不接受发生冲突，请各自先协商底线；本次没有发起外部查询。");
  if (must.size > 4) throw new TripError(422, "双方必须去合计超过四站，与当前半日最多四站的范围冲突；本次没有发起查询。");
  return trip.candidates.filter((c) => ids.has(c.id));
}
export function makeQuote(tripId: string, expected: number): VerifyQuote {
  let quote!: VerifyQuote;
  mutate(tripId, (trip) => {
    const candidates = workingCandidates(trip);
    const initial = !trip.initialMeasured || !factsFresh(trip);
    let walkingUpperBound = candidates.length * candidates.length;
    if (!initial && trip.facts) {
      const keys = new Set<string>();
      for (const candidate of candidates) for (const edge of estimateMissingEdges(trip.facts, [candidate.id], { universe: candidates.map((c) => c.id) })) keys.add(edge.key);
      walkingUpperBound = keys.size;
      // A newly selected candidate is not in facts yet. Quote its full directed connections.
      for (const candidate of candidates.filter((c) => !trip.facts!.pool.some((s) => s.id === c.id))) {
        keys.add(FACT_START_KEY + "->" + candidate.id);
        for (const other of candidates.filter((c) => c.id !== candidate.id)) {
          keys.add(other.id + "->" + candidate.id); keys.add(candidate.id + "->" + other.id);
        }
      }
      walkingUpperBound = [...keys].filter((key) => !trip.facts!.legs[key] && !trip.facts!.failedPairs.includes(key)).length;
    }
    quote = { id: id("quote_"), signature: signature(trip), candidateIds: candidates.map((c) => c.id),
      expiresAt: new Date(Date.now() + 5 * 60000).toISOString(), initial,
      placeUpperBound: (trip.facts?.start && factsFresh(trip) ? 0 : 1) +
        candidates.filter((c) => !c.amap || !c.identityMeasuredAt || Date.now() - Date.parse(c.identityMeasuredAt) >= TTL).length,
      walkingUpperBound };
    trip.quote = quote;
  }, expected);
  return quote;
}
function meterBudget(tripId: string, work: () => Promise<unknown>): Promise<unknown> {
  return withAmapBudget((api) => charge(tripId, api.includes("walking") ? "amap-walking-http" : "amap-place-http",
    api.includes("walking") ? 80 : 40, 3600000, "global", api), work);
}
async function place(tripId: string, name: string, providers: RouteProviders) {
  const cacheKey = "amap-place:" + hash("杭州:" + name);
  const cached = evidence<AmapPoi[]>(cacheKey, TTL);
  if (cached) return cached;
  let result!: AmapCallResult<AmapPoi[]>;
  await meterBudget(tripId, async () => { result = await providers.place(name); });
  if (!result.ok || !result.data) throw new TripError(502, result.error ?? "高德地点查询失败。");
  const at = result.measuredAt ?? result.entry.at;
  putEvidence(cacheKey, result.data, at); return { value: result.data, at };
}
function matchName(name: string): string { return name.normalize("NFKC").replace(/[\s·•\-（）()]/g, "").toLowerCase(); }
function suitable(poi: AmapPoi): boolean {
  return isPlausiblePlace(poi) && poi.position.lat > 29 && poi.position.lat < 31 && poi.position.lng > 118 && poi.position.lng < 121;
}
export async function enrich(job: TripJob, discover = discoverCity): Promise<unknown> {
  const category = String(job.input.category ?? "城市观光");
  if (!(FLYAI_POI_CATEGORIES as readonly string[]).includes(category)) throw new TripError(400, "不支持该飞猪类别。");
  const cacheKey = "flyai:" + hash("杭州:" + category);
  const cached = evidence<DiscoverBatch>(cacheKey, 10 * 60000);
  let batch = cached?.value;
  if (!batch) {
    charge(job.tripId, "flyai", 12, 3600000, "global");
    batch = await discover("杭州", [category as FlyAiPoiCategory]);
    if (batch.ok) putEvidence(cacheKey, batch, batch.results[0]?.proof?.invokedAt ?? batch.fetchedAt);
  }
  if (!batch.ok) throw new TripError(502, batch.error ?? "飞猪未返回候选。");
  const measuredAt = cached?.at ?? batch.results[0]?.proof?.invokedAt ?? batch.fetchedAt;
  mutate(job.tripId, (trip) => {
    for (const poi of batch.results.flatMap((r) => r.items)) {
      // Similar or identical names do not establish a cross-platform identity.
      // Keep new FlyAI records separate until Amap identity permits an explicit merge.
      let candidate = trip.candidates.find((c) => c.flyai?.id === poi.id);
      if (!candidate) { candidate = { id: id("stop_"), name: poi.name, aliases: [], selected: false,
        materialIds: [], flyai: null, amap: null, choices: [], identity: "pending", identityMeasuredAt: null };
        trip.candidates.push(candidate); }
      candidate.flyai = poi; candidate.flyaiMeasuredAt = measuredAt;
    }
  });
  return { added: batch.results.reduce((n, r) => n + r.items.length, 0) };
}
export function editCandidate(tripId: string, candidateId: string, expected: number, value: Record<string, unknown>): void {
  mutate(tripId, (trip) => {
    const candidate = trip.candidates.find((c) => c.id === candidateId);
    if (!candidate) throw new TripError(404, "地点不存在。");
    if (typeof value.selected === "boolean") candidate.selected = value.selected;
    if (typeof value.name === "string") {
      const name = value.name.trim();
      if (!name || name.length > 100) throw new TripError(400, "地点名称需在一百字以内。");
      if (trip.plan && trip.facts?.pool.some((s) => s.id === candidateId)) throw new TripError(409, "已进入核验的地点不能直接改名；请另加候选重新核验。");
      candidate.aliases.push(candidate.name); candidate.name = name; candidate.amap = null;
      candidate.identity = "pending"; candidate.identityMeasuredAt = null;
    }
    if (typeof value.amapId === "string") {
      const choice = candidate.choices.find((c) => c.id === value.amapId);
      if (!choice) throw new TripError(400, "请从本次高德返回的候选中确认身份。");
      if (candidate.amap && candidate.amap.id !== choice.id && trip.plan) {
        suspend(trip, "地点身份已改变，旧路段与确认不能用于新地点");
        if (trip.facts) {
          trip.facts.pool = trip.facts.pool.filter((s) => s.id !== candidateId);
          trip.facts.legs = Object.fromEntries(Object.entries(trip.facts.legs).filter(([key]) => !key.split("->").includes(candidateId)));
          trip.facts.failedPairs = trip.facts.failedPairs.filter((key) => !key.split("->").includes(candidateId));
        }
      }
      candidate.amap = choice; candidate.identity = "verified";
      // Keep the original query timestamp; user confirmation does not refresh facts.
    }
    trip.quote = null;
  }, expected);
}
export async function verifyTrip(job: TripJob, providers: RouteProviders = realRoutes): Promise<unknown> {
  const original = loadTrip(job.tripId), quote = original.quote;
  if (!quote || quote.id !== job.input.quoteId || quote.signature !== signature(original) || Date.parse(quote.expiresAt) < Date.now())
    throw new TripError(409, "报价已过期或条件已变化，请重新查看报价。");
  if (!quote.initial && (quote.walkingUpperBound > 9 || original.incrementalWalking + quote.walkingUpperBound > 18))
    throw new TripError(422, "本次缺边超出单轮九段或累计十八段补测上限，请缩减候选。");
  if (!quote.initial && quote.walkingUpperBound > 6 && (job.owner !== "A" || job.input.approveCost !== true))
    throw new TripError(422, "新增测量超过六段，需要发起人明确批准本次报价。");
  const inputCandidates = workingCandidates(original);
  mutate(job.tripId, (trip) => { suspend(trip, "正在核验新选择，完成前暂停执行"); });
  const resolved: PoiCandidate[] = [];
  for (const source of inputCandidates) {
    const candidate = structuredClone(source);
    if (!candidate.amap || !candidate.identityMeasuredAt || Date.now() - Date.parse(candidate.identityMeasuredAt) >= TTL) {
      const result = await place(job.tripId, candidate.name, providers);
      const choices = result.value.filter(suitable);
      const exact = choices.filter((p) => matchName(p.name) === matchName(candidate.name));
      const selected = candidate.amap && choices.find((p) => p.id === candidate.amap?.id);
      candidate.choices = choices; candidate.identityMeasuredAt = result.at;
      if (selected) candidate.amap = selected;
      else candidate.amap = exact.length === 1 ? exact[0] : null;
      candidate.identity = candidate.amap ? "verified" : "ambiguous";
      mutate(job.tripId, (trip) => {
        const current = trip.candidates.find((c) => c.id === candidate.id)!;
        if (current.name === candidate.name) Object.assign(current, { choices: candidate.choices, amap: candidate.amap,
          identity: candidate.identity, identityMeasuredAt: candidate.identityMeasuredAt });
      });
    }
    if (!candidate.amap) throw new TripError(409, "「" + candidate.name + "」存在同名或不确定地点，请先在地点卡确认高德身份；已查到的数据保留。");
    if (!suitable(candidate.amap)) throw new TripError(422, "「" + candidate.name + "」不符合杭州地点本体的核验范围，未把餐厅、车站或停车场当作景点。");
    resolved.push(candidate);
  }
  const flyaiPairs = resolved.filter((c) => c.flyai).map((c) => ({ flyai: c.flyai!, amap: c.amap! }));
  const crossChecks = compareVerifiedPoiPairs(flyaiPairs);
  for (const candidate of resolved.filter((c) => c.flyai)) {
    const match = crossChecks.find((m) => m.flyaiId === candidate.flyai!.id)!;
    candidate.crossCheck = { status: match.status, reason: match.reason, routable: match.routable };
    mutate(job.tripId, (trip) => { trip.candidates.find((c) => c.id === candidate.id)!.crossCheck = candidate.crossCheck; });
    if (!match.routable) throw new TripError(422, "「" + candidate.name + "」飞猪与高德身份尚不能互相印证：" + match.routableReason + "。本次没有把它作为已核验地点。");
  }
  // Merge only after Amap identity establishes that two labels are the same physical POI.
  const seen = new Map<string, string>();
  for (const candidate of resolved) {
    const duplicate = seen.get(candidate.amap!.id);
    if (duplicate) throw new TripError(409, "「" + candidate.name + "」与另一个候选是同一高德地点，请先合并候选后再核验。");
    seen.set(candidate.amap!.id, candidate.id);
  }
  let start = original.facts && factsFresh(original) ? original.facts.start : null;
  let startAt = original.facts?.measuredAt ?? new Date().toISOString();
  if (!start) {
    const result = await place(job.tripId, "湖滨公园", providers);
    const poi = result.value.find((p) => suitable(p) && p.name.includes("湖滨公园"));
    if (!poi) throw new TripError(422, "未能确定湖滨公园起点，本次不生成路线。");
    startAt = result.at;
    start = { name: poi.name, amapId: poi.id, address: poi.address, position: poi.position, reason: "高德核实的杭州湖滨公园起点" };
  }
  const { startMinutes, endMinutes } = assumedTripWindow(new Date());
  const facts: FactSet = quote.initial ? { factsId: id("facts_"), cityName: "杭州", categories: [],
    start, pool: [], legs: {}, failedPairs: [], measuredAt: startAt } : structuredClone(original.facts!);
  for (const candidate of resolved) {
    if (haversineMeters(start.position, candidate.amap!.position) > MAX_STRAIGHT_LINE_METERS) throw new TripError(422, "「" + candidate.name + "」超出起点八公里的半日步行候选范围，请主动缩减或更换。本次未测该路段，不断言实际步行不可行。");
    const opening = evaluateOpening({ amap: candidate.amap } as CandidateMatch, startMinutes, endMinutes);
    const row = { id: candidate.id, flyaiId: candidate.flyai && !candidate.flyai.missingFields.includes("id") ? candidate.flyai.id : null, name: candidate.name,
      position: candidate.amap!.position, matchStatus: candidate.crossCheck?.status === "suspicious" ? "suspicious" as const : "matched" as const,
      openingStatus: opening.status, openingNote: opening.note, stayMinutes: SIMULATED_STAY_MINUTES,
      straightLineMeters: Math.round(haversineMeters(start.position, candidate.amap!.position)),
      amapId: candidate.amap!.id, address: candidate.amap!.address, category: candidate.flyai?.category ?? null,
      rating: candidate.amap!.rating, jumpUrl: candidate.flyai?.jumpUrl ?? null, flyaiDescription: candidate.flyai?.description ?? null };
    facts.pool = facts.pool.filter((s) => s.id !== row.id); facts.pool.push(row);
  }
  // Limit the active search universe to the user-selected six; other candidates remain in the workspace.
  facts.pool = facts.pool.filter((s) => resolved.some((c) => c.id === s.id));
  const targets = resolved.map((c) => c.id), edges: { from: string; to: string }[] = [];
  for (const to of targets) edges.push({ from: FACT_START_KEY, to });
  for (const from of targets) for (const to of targets) if (from !== to) edges.push({ from, to });
  const missing = edges.filter((edge) => !facts.legs[edge.from + "->" + edge.to] && !facts.failedPairs.includes(edge.from + "->" + edge.to));
  if (!quote.initial && missing.length > quote.walkingUpperBound) throw new TripError(409, "实际缺边超过报价，请重新报价。");
  const oldMeasuredAt = facts.measuredAt;
  const measuredTimes = [startAt, ...resolved.map((c) => c.identityMeasuredAt!)];
  facts.measuredAt = new Date(Math.min(Date.parse(facts.measuredAt), ...measuredTimes.map((at) => Date.parse(at)))).toISOString();
  for (const edge of missing) {
    const from = edge.from === FACT_START_KEY ? start : facts.pool.find((s) => s.id === edge.from)!;
    const to = facts.pool.find((s) => s.id === edge.to)!;
    const pairKey = edge.from + "->" + edge.to;
    const cached = evidence<AmapWalkingData>("walking:" + hash(JSON.stringify([from.position, to.position])), TTL);
    let data: AmapWalkingData, at: string, fromCache = false;
    if (cached) { data = cached.value; at = cached.at; fromCache = true; }
    else {
      if (!quote.initial) mutate(job.tripId, (trip) => {
        if (trip.incrementalWalking >= 18) throw new TripError(422, "本空间补测累计已达十八段。");
        trip.incrementalWalking++;
      });
      let result!: AmapCallResult<AmapWalkingData>;
      await meterBudget(job.tripId, async () => { result = await providers.walk(from.position, to.position); });
      if (!result.ok || !result.data) {
        // Network, quota and rate errors are not proof that a walking route does not exist.
        throw new TripError(502, result.error ?? "路段核验失败；已测成功路段已保留。");
      }
      data = result.data; at = result.measuredAt ?? result.entry.at; fromCache = result.entry.fromCache;
      if (fromCache && !quote.initial) mutate(job.tripId, (trip) => { trip.incrementalWalking = Math.max(0, trip.incrementalWalking - 1); });
      putEvidence("walking:" + hash(JSON.stringify([from.position, to.position])), data, at);
    }
    facts.legs[pairKey] = { leg: toLeg(from.name, to.name, from.position, to.position, data, fromCache), measuredAt: at };
    measuredTimes.push(at);
    facts.measuredAt = new Date(Math.min(Date.parse(facts.measuredAt), Date.parse(at))).toISOString();
    // Save every paid successful edge immediately, including before a later failure.
    mutate(job.tripId, (trip) => { trip.facts = structuredClone(facts); });
  }
  for (const value of Object.values(facts.legs)) measuredTimes.push(value.measuredAt);
  facts.measuredAt = new Date(Math.min(...measuredTimes.map((s) => Date.parse(s)))).toISOString();
  if (!Number.isFinite(Date.parse(facts.measuredAt))) facts.measuredAt = oldMeasuredAt;
  return mutate(job.tripId, (trip) => {
    trip.facts = facts;
    const expectedConditions = JSON.stringify(original.conditions);
    if (JSON.stringify(trip.conditions) !== expectedConditions || !!trip.members.B !== !!original.members.B
      || JSON.stringify(workingCandidates(trip).map((c) => c.id)) !== JSON.stringify(inputCandidates.map((c) => c.id))) {
      suspend(trip, "测量期间条件或参与者已变化，数据保留，请重新核验当前选择");
      throw new TripError(409, "条件发生变化，未把旧输入生成的路线设为当前方案。");
    }
    trip.initialMeasured = true; trip.quote = null;
    solveTrip(trip, job.owner);
    if (trip.plan) { trip.plan.budget.spentThisPlan = trip.incrementalWalking; trip.plan.budget.spentThisResolve = trip.incrementalWalking - original.incrementalWalking; trip.plan.budget.logicalRequests = trip.incrementalWalking; }
    return { revision: trip.plan?.headRevision, outcome: trip.plan?.status, note: "所有路线数字来自高德；停留时间仍为模拟值。" };
  });
}
export function mergeCandidates(tripId: string, keepId: string, removeId: string, expected: number): void {
  mutate(tripId, (trip) => {
    const keep = trip.candidates.find((c) => c.id === keepId), remove = trip.candidates.find((c) => c.id === removeId);
    if (!keep || !remove || keepId === removeId || !keep.amap || keep.amap.id !== remove.amap?.id) throw new TripError(400, "只允许合并高德身份一致的两个候选。");
    if (trip.plan) throw new TripError(409, "已有路线时请先保留一个候选参与本轮比较，不能直接改写历史标识。");
    for (const party of [trip.conditions.A, trip.conditions.B].filter(Boolean) as PartyConditions[]) {
      const must = party.hard.mustVisit.includes(removeId), never = party.hard.neverAccept.includes(removeId);
      if ((must && party.hard.neverAccept.includes(keepId)) || (never && party.hard.mustVisit.includes(keepId))) throw new TripError(409, "合并会使个人选择互相矛盾，请本人先调整条件。");
      party.hard.mustVisit = [...new Set(party.hard.mustVisit.map((v) => v === removeId ? keepId : v))];
      party.hard.neverAccept = [...new Set(party.hard.neverAccept.map((v) => v === removeId ? keepId : v))];
      if (party.soft[removeId]) { if (party.soft[keepId] && party.soft[keepId] !== party.soft[removeId]) throw new TripError(409, "两个别名的个人偏好不同，请先调整。");
        party.soft[keepId] = party.soft[removeId]; delete party.soft[removeId]; }
    }
    keep.materialIds = [...new Set([...keep.materialIds, ...remove.materialIds])];
    keep.aliases = [...new Set([...keep.aliases, remove.name, ...remove.aliases])];
    if (!keep.flyai && remove.flyai) { keep.flyai = remove.flyai; keep.flyaiMeasuredAt = remove.flyaiMeasuredAt; }
    keep.selected ||= remove.selected; trip.candidates = trip.candidates.filter((c) => c.id !== removeId); trip.quote = null;
  }, expected);
}
