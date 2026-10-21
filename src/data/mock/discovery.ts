import type { FlyAiPoiCategory } from "@/lib/discovery";
import type { DiscoverBatch, DiscoverCategoryResult, DiscoveredPoi } from "@/lib/types";
import { MOCK_POIS } from "./pois";

const CATEGORY_LABELS: Record<string, string> = {
  "quiet-street": "安静街区",
  nature: "自然风光",
  culture: "人文街区",
  landmark: "城市地标",
};

/**
 * ⚠️ MOCK DATA — 只在 /api/discover 失败、用户主动点击「改用演示数据」时展示。
 * 演示 POI 本来就没有地址、飞猪链接与简介，缺失字段照实标出，不拿别的字段冒充。
 */
export const MOCK_DISCOVERED_POIS: DiscoveredPoi[] = MOCK_POIS.map((poi) => ({
  id: poi.id,
  name: poi.name,
  address: null,
  category: CATEGORY_LABELS[poi.category] ?? null,
  position: poi.position,
  coordinatesVerified: false,
  jumpUrl: null,
  description: null,
  source: "mock",
  missingFields: ["address", "jumpUrl", "description"],
}));

export function createMockDiscoverBatch(
  cityName: string,
  categories: FlyAiPoiCategory[],
): DiscoverBatch {
  const results: DiscoverCategoryResult[] = categories.map((category) => ({
    category,
    items: MOCK_DISCOVERED_POIS,
    error: null,
    proof: null,
  }));
  return {
    cityName,
    origin: "mock-fallback",
    fetchedAt: new Date().toISOString(),
    ok: true,
    error: null,
    results,
  };
}
