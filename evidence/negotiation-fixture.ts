import type { LatLng, RouteStart } from "@/lib/types";
import { FACT_START_KEY, type FactEntry, type FactSet, type FactStop } from "../src/lib/negotiation/types.ts";
import { legKey } from "../src/lib/itinerary-compose.ts";

/**
 * 夹具数据：这些数字**不是高德返回**，只用来在零付费的前提下验证求解、差异与状态规则。
 * 真实路线仍由 /api/verify 实测验收；这里通过的用例不代表任何真实能力。
 * 步行速度按 80 米/分钟（≈4.8 公里/小时）一致换算；折线一律留空数组，绝不虚构几何。
 */

const SPEED_METERS_PER_MINUTE = 80;

function point(lat: number, lng: number): LatLng {
  return { lat, lng };
}

function leg(fromName: string, toName: string, from: LatLng, to: LatLng, minutes: number, fromCache = false): FactEntry {
  return {
    measuredAt: "2026-10-21T04:00:00.000Z",
    leg: {
      fromName,
      toName,
      from,
      to,
      distanceMeters: minutes * SPEED_METERS_PER_MINUTE,
      durationMinutes: minutes,
      durationSeconds: minutes * 60,
      stepCount: 0,
      firstInstruction: null,
      polyline: [],
      fromCache,
    },
  };
}

function stop(
  id: string,
  name: string,
  position: LatLng,
  straightLineMeters: number,
  overrides: Partial<FactStop> = {},
): FactStop {
  return {
    id,
    name,
    position,
    matchStatus: "matched",
    openingStatus: "no-conflict",
    openingNote: "夹具：按假定窗口不冲突",
    stayMinutes: 30,
    straightLineMeters,
    amapId: `amap-${id}`,
    ...overrides,
  };
}

const START: RouteStart = {
  name: "湖滨公园（夹具起点）",
  amapId: "amap-start",
  address: "杭州市上城区",
  position: point(30.255, 120.155),
  reason: "夹具：与真实流程相同的固定起点设定",
};

interface ClusterSpec {
  id: string;
  name: string;
  position: LatLng;
  startMinutes: number;
}

/** 5 站全互测（20 条有向段 + 5 条起点段 = 25 段，与单类别实测的段数量级一致）。 */
const COMPLETE_CLUSTER: ClusterSpec[] = [
  { id: "c1", name: "集贤亭", position: point(30.256, 120.154), startMinutes: 4 },
  { id: "c2", name: "湖滨步行街", position: point(30.257, 120.153), startMinutes: 8 },
  { id: "c3", name: "圣塘景区", position: point(30.2585, 120.152), startMinutes: 12 },
  { id: "c4", name: "断桥残雪", position: point(30.2615, 120.148), startMinutes: 20 },
  { id: "c5", name: "雷峰塔", position: point(30.243, 120.149), startMinutes: 30 },
];

const COMPLETE_PAIRS: [string, string, number][] = [
  ["c1", "c2", 6], ["c2", "c1", 6],
  ["c2", "c3", 8], ["c3", "c2", 8],
  ["c1", "c3", 10], ["c3", "c1", 10],
  ["c3", "c4", 12], ["c4", "c3", 12],
  ["c2", "c4", 14], ["c4", "c2", 14],
  ["c1", "c4", 18], ["c4", "c1", 18],
  ["c4", "c5", 22], ["c5", "c4", 22],
  ["c3", "c5", 26], ["c5", "c3", 26],
  ["c2", "c5", 30], ["c5", "c2", 30],
  ["c1", "c5", 34], ["c5", "c1", 34],
];

export function makeCompleteFacts(): FactSet {
  const legs: Record<string, FactEntry> = {};
  const pool = COMPLETE_CLUSTER.map((item) => stop(item.id, item.name, item.position, item.startMinutes * SPEED_METERS_PER_MINUTE));
  for (const item of COMPLETE_CLUSTER) {
    legs[legKey(FACT_START_KEY, item.id)] = leg(START.name, item.name, START.position, item.position, item.startMinutes);
  }
  for (const [fromId, toId, minutes] of COMPLETE_PAIRS) {
    const from = COMPLETE_CLUSTER.find((item) => item.id === fromId)!;
    const to = COMPLETE_CLUSTER.find((item) => item.id === toId)!;
    legs[legKey(fromId, toId)] = leg(from.name, to.name, from.position, to.position, minutes);
  }
  return {
    factsId: "facts-complete-001",
    cityName: "杭州",
    categories: ["自然风光"],
    start: START,
    pool,
    legs,
    failedPairs: [],
    measuredAt: "2026-10-21T04:00:00.000Z",
  };
}

/**
 * 模拟真实核验的产物：最近 6 站之间有全互测段，
 * 排在第 7、8 的候选只测过「起点→它」，两两之间从没实测——这正是「必须去」撞短名单的形态。
 */
const SHORTLISTED: ClusterSpec[] = [
  ...COMPLETE_CLUSTER,
  { id: "s7", name: "岳王庙（夹具：短名单外）", position: point(30.268, 120.14), startMinutes: 33 },
  { id: "s8", name: "曲院风荷（夹具：短名单外）", position: point(30.27, 120.138), startMinutes: 36 },
];

export function makeShortlistedFacts(): FactSet {
  const facts = makeCompleteFacts();
  facts.factsId = "facts-shortlisted-001";
  for (const item of [SHORTLISTED[5], SHORTLISTED[6]]) {
    facts.pool.push(stop(item.id, item.name, item.position, item.startMinutes * SPEED_METERS_PER_MINUTE));
    facts.legs[legKey(FACT_START_KEY, item.id)] = leg(START.name, item.name, START.position, item.position, item.startMinutes);
  }
  // 起点→断桥残雪 这一条改成「高德明确没有路线」，用来区分「有证据的排除」与「从没测过」
  delete facts.legs[legKey(FACT_START_KEY, "c4")];
  facts.failedPairs.push(legKey(FACT_START_KEY, "c4"));
  return facts;
}
