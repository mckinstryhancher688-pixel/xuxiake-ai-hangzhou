import { randomBytes } from "node:crypto";
import { haversineMeters } from "@/lib/geo";
import type { CandidateMatch, RouteStart, WalkingLeg } from "@/lib/types";
import { SIMULATED_STAY_MINUTES } from "@/lib/verification";
import { FACT_START_KEY, type FactEntry, type FactSet, type FactStop } from "@/lib/negotiation/types";

if (typeof window !== "undefined") {
  throw new Error("lib/server/facts 只能在 Next.js 服务端加载。");
}

/**
 * 事实层入库。
 *
 * 核验流水线本来就已经把「起点→每个已核验候选」和「短名单两两之间」的步行段全部
 * 用高德实测出来了，只是过去只把入选链条留下、其余当场丢弃。留下来之后，
 * 双人协商的重排、删站、换站都只是在这批已付费数据上做纯计算，新增调用为 0。
 *
 * 与 amap.ts 的 6 小时缓存同寿命：这里存的是「我们确实测过什么」的事实账，
 * 进程重启即失效，绝不假装能跨重启恢复。
 */
const FACTS_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_FACT_SETS = 12;

interface FactRecord {
  at: number;
  facts: FactSet;
}

const factStore = new Map<string, FactRecord>();

export interface FactSummary {
  factsId: string;
  cityName: string;
  categories: string[];
  /** 可点选全集：身份已核验且有高德坐标的候选数（含最近 6 个之外的） */
  poolSize: number;
  measuredPairs: number;
  failedPairs: number;
  /** 起点腿实测条数；这些段只测了「起点→候选」，候选两两之间未必测过 */
  startLegs: number;
  measuredAt: string;
}

function pruneFacts(): void {
  const cutoff = Date.now() - FACTS_TTL_MS;
  for (const [key, record] of factStore) {
    if (record.at < cutoff) factStore.delete(key);
  }
  while (factStore.size > MAX_FACT_SETS) {
    const oldest = [...factStore.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    factStore.delete(oldest[0]);
  }
}

export function mintFactsId(): string {
  return randomBytes(12).toString("base64url");
}

export function buildFactSet(input: {
  factsId: string;
  cityName: string;
  categories: string[];
  start: RouteStart;
  matches: CandidateMatch[];
  legs: Map<string, WalkingLeg>;
  failedKeys: string[];
}): FactSet {
  const measuredAt = new Date().toISOString();
  const routable = input.matches.filter((match) => match.routable && match.routablePosition);
  const pool: FactStop[] = routable.map((match) => ({
    id: match.flyaiId,
    name: match.name,
    position: match.routablePosition as FactStop["position"],
    matchStatus: match.status,
    openingStatus: match.openingStatus,
    openingNote: match.openingNote,
    stayMinutes: SIMULATED_STAY_MINUTES,
    straightLineMeters: Math.round(haversineMeters(input.start.position, match.routablePosition as FactStop["position"])),
    amapId: match.amap?.id ?? "",
    address: match.amap?.address ?? null,
    jumpUrl: match.jumpUrl,
    flyaiDescription: match.flyaiDescription,
    category: match.category ?? null,
    rating: match.amap?.rating ?? null,
    flyaiCollectedAt: match.flyaiCollectedAt ?? null,
    flyaiIdFromSource: match.flyaiIdFromSource,
  }));

  const legs: Record<string, FactEntry> = {};
  for (const [key, leg] of input.legs) {
    legs[key] = { leg, measuredAt };
  }

  return {
    factsId: input.factsId,
    cityName: input.cityName,
    categories: [...input.categories],
    start: input.start,
    pool,
    legs,
    failedPairs: input.failedKeys.filter((key) => !legs[key]),
    measuredAt,
  };
}

export function putFactSet(facts: FactSet): FactSummary {
  pruneFacts();
  factStore.set(facts.factsId, { at: Date.now(), facts });
  return factsSummaryOf(facts);
}

/**
 * 从快照恢复时用的入口：有效期按原始采集时间算，不按恢复时间算。
 * 于是「6 小时前测的」在重启之后依然是 6 小时前测的——过期就是过期，
 * 端点会如实报失效并报价，不会借重启偷偷续期，更不会自动重跑付费核验。
 */
export function restoreFactSet(facts: FactSet): FactSummary {
  const at = Date.parse(facts.measuredAt);
  factStore.set(facts.factsId, { at: Number.isNaN(at) ? 0 : at, facts });
  pruneFacts();
  return factsSummaryOf(facts);
}

export function factsSummaryOf(facts: FactSet): FactSummary {
  const keys = Object.keys(facts.legs);
  return {
    factsId: facts.factsId,
    cityName: facts.cityName,
    categories: [...facts.categories],
    poolSize: facts.pool.length,
    measuredPairs: keys.filter((key) => !key.startsWith(`${FACT_START_KEY}->`)).length,
    startLegs: keys.filter((key) => key.startsWith(`${FACT_START_KEY}->`)).length,
    failedPairs: facts.failedPairs.length,
    measuredAt: facts.measuredAt,
  };
}

/** 命中返回 null 时，调用方必须如实告诉用户「事实已失效，需要重新核验」，不能悄悄重跑付费流程。 */
export function getFactSet(factsId: string): FactSet | null {
  pruneFacts();
  const record = factStore.get(factsId);
  if (!record) return null;
  record.at = Date.now();
  return record.facts;
}

export function factsStoreStatus(): { entries: number; ttlSeconds: number } {
  pruneFacts();
  return { entries: factStore.size, ttlSeconds: Math.round(FACTS_TTL_MS / 1000) };
}
