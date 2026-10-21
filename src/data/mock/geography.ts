import type { LatLng } from "@/lib/types";

/**
 * ⚠️ MOCK DATA — 手绘示意地理底图。
 * 湖岸线与道路是按西湖大致形状手描的折线，不是真实地理边界，
 * 也不是高德/飞猪返回的数据。仅用于让演示地图看起来像地图。
 * 接入高德后整个文件作废，改用高德底图瓦片。
 */
export const MOCK_LAKE_OUTLINE: LatLng[] = [
  { lat: 30.2592, lng: 120.1512 },
  { lat: 30.256, lng: 120.157 },
  { lat: 30.2505, lng: 120.1585 },
  { lat: 30.2455, lng: 120.158 },
  { lat: 30.24, lng: 120.156 },
  { lat: 30.236, lng: 120.152 },
  { lat: 30.231, lng: 120.1495 },
  { lat: 30.227, lng: 120.145 },
  { lat: 30.229, lng: 120.139 },
  { lat: 30.236, lng: 120.137 },
  { lat: 30.243, lng: 120.138 },
  { lat: 30.25, lng: 120.142 },
  { lat: 30.2545, lng: 120.145 },
  { lat: 30.2575, lng: 120.148 },
];

export const MOCK_STREETS: { name: string; path: LatLng[] }[] = [
  {
    name: "湖滨路 · 南山路",
    path: [
      { lat: 30.2565, lng: 120.16 },
      { lat: 30.2505, lng: 120.1628 },
      { lat: 30.2455, lng: 120.1618 },
      { lat: 30.24, lng: 120.1598 },
      { lat: 30.236, lng: 120.1558 },
      { lat: 30.231, lng: 120.1528 },
    ],
  },
  {
    name: "平海路",
    path: [
      { lat: 30.2536, lng: 120.169 },
      { lat: 30.2538, lng: 120.1615 },
    ],
  },
];

export const MOCK_METRO_STATIONS: { name: string; line: string; position: LatLng }[] = [
  { name: "龙翔桥", line: "1 号线", position: { lat: 30.2548, lng: 120.1668 } },
  { name: "吴山广场", line: "7 号线", position: { lat: 30.2372, lng: 120.1585 } },
];
