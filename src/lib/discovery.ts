import type { DiscoveredPoiMissingField } from "@/lib/types";

/** 浏览器只调这一个站内地址，飞猪凭证与 CLI 调用都留在服务端。 */
export const DISCOVER_ENDPOINT = "/api/discover";

/**
 * 已经用真实 key 验证过能返回数据的类别（flyai search-poi --category）。
 * 服务端只接受这个白名单里的值，请求体里的其它字符串一律丢弃，
 * 因此类别参数不会被拼进 shell 命令。
 */
export const FLYAI_POI_CATEGORIES = ["自然风光", "文创街区", "城市观光"] as const;

export type FlyAiPoiCategory = (typeof FLYAI_POI_CATEGORIES)[number];

/** 默认只查一个类别：每多选一个类别，服务端就多一次真实 CLI 调用。 */
export const DEFAULT_DISCOVER_CATEGORIES: FlyAiPoiCategory[] = ["文创街区"];

/** 单次「重新发现」最多查几个类别，用来控制调用量与费用。 */
export const MAX_CATEGORIES_PER_CALL = 2;

/** 第二阶段只做杭州，不做全国城市切换。 */
export const SUPPORTED_CITIES = ["杭州"] as const;

export const MISSING_FIELD_LABELS: Record<DiscoveredPoiMissingField, string> = {
  id: "ID",
  address: "地址",
  category: "分类",
  position: "坐标",
  jumpUrl: "飞猪链接",
  description: "简介",
};

/** 服务端状态，用于在页面上证明「请求确实是在服务端发出的」。 */
export interface FlyAiServerStatus {
  keyPresent: boolean;
  /** 脱敏后的 key 形状，例如 sk-1EYu****co；绝不返回完整值 */
  keyMask: string | null;
  cliEntry: string | null;
  cliAvailable: boolean;
  cacheTtlSeconds: number;
  cacheEntries: { key: string; ageSeconds: number; itemCount: number }[];
  hourlyCallsUsed: number;
  hourlyCallCap: number;
  serverTime: string;
  pid: number;
}

export function pickCity(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const city = input.trim();
  return (SUPPORTED_CITIES as readonly string[]).includes(city) ? city : null;
}

/**
 * 只返回白名单里的类别，不替调用方补默认值：
 * 传了非法类别就应该报错，而不是静默换成另一个类别去查询。
 */
export function parseCategories(input: unknown): FlyAiPoiCategory[] {
  if (!Array.isArray(input)) return [];
  const picked: FlyAiPoiCategory[] = [];
  for (const value of input) {
    const match = FLYAI_POI_CATEGORIES.find((category) => category === value);
    if (match && !picked.includes(match)) picked.push(match);
    if (picked.length >= MAX_CATEGORIES_PER_CALL) break;
  }
  return picked;
}

/** 类别是集合；勾选顺序变化不应把同一份结果标成过期。 */
export function sameCategories(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((category) => b.has(category));
}
