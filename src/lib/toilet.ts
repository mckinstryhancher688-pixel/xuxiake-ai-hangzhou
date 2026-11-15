import type { LatLng, NearestToilet } from "@/lib/types";
import { haversineMeters } from "./geo.ts";

/**
 * 沿途无障碍洗手间（亲情场景）。
 *
 * 口径（必须与界面文案一致，不许含糊）：
 * - 只在「起点 + 行程各站」附近找高德标注的无障碍洗手间（分类码 200303）；
 * - 距离是**直线距离**，不是步行距离。高德走一段要另花钱，这里不做；
 * - 「高德标注的无障碍洗手间」只代表这个点被标注成该类型，
 *   **不代表整条路线无障碍**，也不代表当天开放。
 *
 * 全程一次 place/text 查询即可覆盖整趟行程（实测 region=杭州 + types=200303 一次返回 10 条），
 * 不需要每站各查一次。
 */

/** 高德 POI 分类码：残障洗手间/无障碍洗手间（官方 POI 分类编码表 2023-10 版）。 */
export const AMAP_ACCESSIBLE_TOILET_TYPECODE = "200303";

/** 超过这个直线距离就不算「沿途」，宁可不写也不误导。 */
export const NEARBY_RADIUS_METERS = 800;

export interface ToiletPoi {
  id: string;
  name: string;
  position: LatLng;
  address: string | null;
  typecode: string | null;
}

export const TOILET_SCOPE_NOTE =
  "无障碍洗手间为高德 POI 标注点（分类码 200303），距离是直线距离、不是步行距离；" +
  `只统计直线 ${NEARBY_RADIUS_METERS} 米内的点。它不代表整条路线无障碍，也不代表当天开放。`;

/** 只保留确实标注成无障碍洗手间的条目：高德偶发会把相近类型混进 types 查询结果。 */
export function isAccessibleToilet(poi: Pick<ToiletPoi, "typecode" | "name">): boolean {
  if (poi.typecode === AMAP_ACCESSIBLE_TOILET_TYPECODE) return true;
  // types 查询理论上只回这一类，但用名称兜底时只在明确写出「无障碍/残障」时才认
  return /无障碍|残障/.test(poi.name);
}

export function nearestToilets(
  toilets: readonly ToiletPoi[],
  anchors: readonly { name: string; position: LatLng }[],
  radiusMeters: number = NEARBY_RADIUS_METERS,
): { nearest: NearestToilet[]; anchorsWithoutToilet: string[] } {
  const valid = toilets.filter(isAccessibleToilet);
  const nearest: NearestToilet[] = [];
  const anchorsWithoutToilet: string[] = [];

  for (const anchor of anchors) {
    let best: { poi: ToiletPoi; meters: number } | null = null;
    for (const poi of valid) {
      const meters = haversineMeters(anchor.position, poi.position);
      if (!best || meters < best.meters) best = { poi, meters };
    }
    if (!best || best.meters > radiusMeters) {
      anchorsWithoutToilet.push(anchor.name);
      continue;
    }
    nearest.push({
      anchorName: anchor.name,
      toiletName: best.poi.name,
      straightLineMeters: Math.round(best.meters),
      address: best.poi.address,
      amapId: best.poi.id,
    });
  }
  return { nearest, anchorsWithoutToilet };
}

/** 面向界面的一句话：把「最近多远」直接说清，不做「附近有」这种含糊表述。 */
export function toiletText(item: NearestToilet): string {
  return `${item.toiletName} · 直线 ${item.straightLineMeters} 米`;
}
