import type { AmapPoi, ToiletLookup } from "@/lib/types";
import {
  AMAP_ACCESSIBLE_TOILET_TYPECODE,
  NEARBY_RADIUS_METERS,
  nearestToilets,
  TOILET_SCOPE_NOTE,
  type ToiletPoi,
} from "@/lib/toilet";
import { searchPlace, type AmapCallResult } from "./amap";

/**
 * 沿途无障碍洗手间：整趟行程只查一次。
 *
 * 一次 place/text（types=200303，region=城市）就能覆盖全城该类 POI，
 * 再在本地按直线距离给每个锚点挑最近的一个。所以每次核验只多 1 次高德调用，
 * 而不是每站一次；命中 6 小时缓存时为 0。
 *
 * 失败不阻断主流程：核验本身仍然成功，只是这块如实写「没查到」。
 */
export async function lookupToilets(
  cityName: string,
  anchors: readonly { name: string; position: { lat: number; lng: number } }[],
): Promise<ToiletLookup> {
  const base: ToiletLookup = {
    cityName,
    found: 0,
    nearest: [],
    anchorsWithoutToilet: anchors.map((item) => item.name),
    newCalls: 0,
    fromCache: false,
    note: TOILET_SCOPE_NOTE,
  };

  if (!anchors.length) return base;

  const result: AmapCallResult<AmapPoi[]> = await searchPlace("", {
    region: cityName,
    cityLimit: true,
    pageSize: 25,
    types: AMAP_ACCESSIBLE_TOILET_TYPECODE,
  });

  if (!result.ok || !result.data) {
    // 查不到就说查不到：不拿通用「公共厕所」冒充无障碍洗手间
    return {
      ...base,
      newCalls: result.entry.fromCache ? 0 : 1,
      fromCache: result.entry.fromCache,
    };
  }

  const toilets: ToiletPoi[] = result.data.map((poi) => ({
    id: poi.id,
    name: poi.name,
    position: poi.position,
    address: poi.address,
    typecode: poi.typecode,
  }));
  const { nearest, anchorsWithoutToilet } = nearestToilets(toilets, anchors, NEARBY_RADIUS_METERS);

  return {
    cityName,
    found: toilets.length,
    nearest,
    anchorsWithoutToilet,
    newCalls: result.entry.fromCache ? 0 : 1,
    fromCache: result.entry.fromCache,
    note: TOILET_SCOPE_NOTE,
  };
}
