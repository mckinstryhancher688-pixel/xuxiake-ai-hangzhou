import type { JourneyContext } from "@/lib/types";
import { MOCK_POIS, MOCK_POI_BY_ID } from "./pois";
import { MOCK_ROUTES, MOCK_ROUTE_BY_ID } from "./routes";
import { MOCK_EXPLORATIONS } from "./explorations";
import {
  MOCK_LAKE_OUTLINE,
  MOCK_STREETS,
  MOCK_METRO_STATIONS,
} from "./geography";
import { MOCK_DISCOVERED_POIS, createMockDiscoverBatch } from "./discovery";

export {
  MOCK_POIS,
  MOCK_POI_BY_ID,
  MOCK_ROUTES,
  MOCK_ROUTE_BY_ID,
  MOCK_EXPLORATIONS,
  MOCK_LAKE_OUTLINE,
  MOCK_STREETS,
  MOCK_METRO_STATIONS,
  MOCK_DISCOVERED_POIS,
  createMockDiscoverBatch,
};

export const MOCK_JOURNEY_CONTEXT: JourneyContext = {
  city: "杭州",
  district: "西湖 · 湖滨",
  interests: ["安静街区", "自然风光", "摄影"],
  budgetCny: 80,
  totalMinutes: 240,
};

/** 全站统一使用的演示数据声明，UI 上必须原样展示。 */
export const DATA_DISCLAIMER =
  "演示数据 · 非实时结果。地点坐标、步行距离与时间均为人工估算，未经高德路径规划或现场核实。";

export const DEFAULT_ROUTE_ID = "standard";
