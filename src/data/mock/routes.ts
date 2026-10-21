import type { JourneyRoute } from "@/lib/types";

/**
 * ⚠️ MOCK DATA — 两条演示路线。
 * 距离与步行时间均为人工估算（按 4–5 km/h），不是高德路径规划结果，
 * 也不是导航实测值。真实接入点见 src/lib/adapters/amap.ts。
 */
export const MOCK_ROUTES: JourneyRoute[] = [
  {
    id: "standard",
    label: "标准半日 · 4 个地点",
    summary:
      "沿湖起步 → 拐进安静里弄 → 南行到城门遗址 → 收尾在柳浪闻莺。全程步行，不需要打车。",
    poiIds: ["hubin-park", "hubian-cun", "yongjinmen", "liulang"],
    legs: [
      {
        fromId: "hubin-park",
        toId: "hubian-cun",
        mode: "walk",
        minutes: 7,
        distanceMeters: 500,
        note: "沿湖滨路向北，绕过步行街商铺段",
      },
      {
        fromId: "hubian-cun",
        toId: "yongjinmen",
        mode: "walk",
        minutes: 19,
        distanceMeters: 1350,
        note: "湖滨路—南山路一路向南，全程湖岸",
      },
      {
        fromId: "yongjinmen",
        toId: "liulang",
        mode: "walk",
        minutes: 9,
        distanceMeters: 650,
        note: "穿过西湖天地外围即可到达",
      },
    ],
    totalWalkMeters: 2500,
    totalMinutes: 195,
    source: "mock",
  },
  {
    id: "short",
    label: "少走一点 · 3 个地点",
    summary:
      "去掉城门遗址那一段绕行，从里弄直接斜切到柳浪闻莺。步行距离少约 1 公里，适合腿力有限或时间被压缩的情况。",
    poiIds: ["hubin-park", "hubian-cun", "liulang"],
    legs: [
      {
        fromId: "hubin-park",
        toId: "hubian-cun",
        mode: "walk",
        minutes: 7,
        distanceMeters: 500,
        note: "沿湖滨路向北",
      },
      {
        fromId: "hubian-cun",
        toId: "liulang",
        mode: "walk",
        minutes: 15,
        distanceMeters: 1050,
        note: "经南山路直下，跳过古湧金门",
      },
    ],
    totalWalkMeters: 1550,
    totalMinutes: 152,
    source: "mock",
  },
];

export const MOCK_ROUTE_BY_ID: Record<string, JourneyRoute> = Object.fromEntries(
  MOCK_ROUTES.map((route) => [route.id, route]),
);
