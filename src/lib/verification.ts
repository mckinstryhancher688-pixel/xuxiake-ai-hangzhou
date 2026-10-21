import type { MatchStatus, OpeningStatus } from "@/lib/types";

/** 浏览器只调这一个站内地址；高德 key 与所有请求都留在服务端。 */
export const VERIFY_ENDPOINT = "/api/verify";

/** 第三阶段固定场景：杭州西湖湖滨，四小时步行漫游。 */
export const VERIFY_CITY = "杭州";
export const VERIFY_DISTRICT = "西湖湖滨";
export const BUDGET_MINUTES = 240;

/** 参与核验的飞猪类别：两类各 10 条，正好是验收里说的 20 条候选。 */
export const VERIFY_CATEGORIES = ["自然风光", "文创街区"] as const;

/** 固定起点关键词，必须是湖滨附近一个能被高德核实的具体地点。 */
export const START_KEYWORD = "湖滨公园";

/**
 * 停留时间是模拟值：飞猪和高德都不会告诉我们「游客会在这儿待多久」。
 * UI 上必须与高德步行计算结果分开标注。
 */
export const SIMULATED_STAY_MINUTES = 30;

/** 等红灯、找路、临时拍照的余量，同样属于产品设定而非实测。 */
export const BUFFER_MINUTES = 20;

/** 偏差超过这个值只标「可疑」，不判定为错——大型景区不同入口本来就有几百米差。 */
export const DEVIATION_SUSPECT_METERS = 200;

/** 两种坐标系假设至少要比这个差距更明显，才敢说判定成立。 */
export const DATUM_DECISIVE_METERS = 100;

/** 最少凑够几站才叫一条行程。 */
export const MIN_STOPS = 3;
export const MAX_STOPS = 4;

/** 路径规划前按「从起点步行多久」先筛掉太远的，控制两两测量的调用量。 */
export const SHORTLIST_SIZE = 6;

/** 直线距离超过这个值直接淘汰：在杭州行政区划内≠四小时走得到。 */
export const MAX_STRAIGHT_LINE_METERS = 8_000;

export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  matched: "已匹配",
  suspicious: "可疑",
  unverified: "未验证",
};

export const OPENING_STATUS_LABELS: Record<OpeningStatus, string> = {
  "open-24h": "全天开放",
  "no-conflict": "营业时间内",
  conflict: "营业时间冲突",
  unknown: "待核实",
};

/**
 * 判定营业时间冲突必须先有一个出发时间。这里固定用 13:00，因为产品设定就是
 * 「半日漫游」＝下午半天；UI 上会明确写出这是假定值而非实测。
 * 不用「当前时间」：深夜跑演示会把所有白天开放的地点全判成营业冲突。
 */
export const ASSUMED_START_HOUR = 13;

export interface TripWindow {
  startAt: Date;
  startMinutes: number;
  endMinutes: number;
}

export function assumedTripWindow(now: Date): TripWindow {
  const startAt = new Date(now);
  startAt.setHours(ASSUMED_START_HOUR, 0, 0, 0);
  const startMinutes = ASSUMED_START_HOUR * 60;
  return { startAt, startMinutes, endMinutes: startMinutes + BUDGET_MINUTES };
}

/** "HH:MM-HH:MM" / "24小时营业" → 分钟区间；解析不了一律返回 null（＝待核实）。 */
export function parseOpeningWindows(text: string | null): [number, number][] | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, "");
  if (normalized.includes("24小时")) return [[0, 24 * 60]];

  const windows: [number, number][] = [];
  for (const part of normalized.split(/[,，、;；/]/)) {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(part);
    if (!match) continue;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    if (end <= start) continue;
    windows.push([start, end]);
  }
  return windows.length ? windows : null;
}

/**
 * 行程窗口 [startMinutes, endMinutes) 是否整段落在营业时间之外。
 * 只有完全不相交才算「确认冲突」；部分重叠不算，避免把只是晚开门的地点误杀。
 * 跨天的营业时间（如 22:00-02:00）不做猜测，解析阶段就已丢弃。
 */
export function isWindowClosed(
  windows: [number, number][],
  startMinutes: number,
  endMinutes: number,
): boolean {
  return windows.every(
    ([openStart, openEnd]) => openEnd <= startMinutes || openStart >= endMinutes,
  );
}

/** GET /api/verify 的返回体：只暴露布尔值与脱敏形状，绝不返回 key 本身。 */
export interface AmapServerStatus {
  keyPresent: boolean;
  keyMask: string | null;
  placeHourlyUsed: number;
  placeHourlyCap: number;
  walkingHourlyUsed: number;
  walkingHourlyCap: number;
  cacheTtlSeconds: number;
  cacheEntries: number;
  pipelineCacheTtlSeconds: number;
  budgetMinutes: number;
  simulatedStayMinutes: number;
  bufferMinutes: number;
  deviationSuspectMeters: number;
  categories: string[];
  startKeyword: string;
  serverTime: string;
  pid: number;
}
