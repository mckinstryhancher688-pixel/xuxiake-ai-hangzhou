import type { LatLng } from "@/lib/types";

/**
 * 纯几何计算，客户端与服务端共用。
 * 注意：haversine 是直线距离，只用于「比较两个坐标系假设哪个更吻合」，
 * 绝不用来当步行距离——步行距离一律取自高德路径规划。
 */

const EARTH_RADIUS_METERS = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

/* ── WGS-84 → GCJ-02 ────────────────────────────────────────────────
 * 高德用的是 GCJ-02（火星坐标）。飞猪返回的坐标系未知，第三阶段的要求是
 * 「先用至少两个已知地标验证坐标系是否一致，不能直接假定 FlyAI 使用 GCJ-02」，
 * 所以需要这个正向变换来检验「飞猪其实是 WGS-84」这一竞争假设：
 * 把飞猪坐标当 WGS-84 转成 GCJ-02，再和高德返回值比，看偏差是否反而更小。
 * 杭州一带该偏移约 300~500 米，远大于 200 米阈值，两种假设可以区分开。
 * 算法为国测局偏移的标准公开实现（克拉索夫斯基椭球长半轴 + 偏心率平方）。
 */

const GCJ02_SEMI_MAJOR = 6_378_245.0;
const GCJ02_EE = 0.006_693_421_622_965_943_23;

function outOfChina(point: LatLng): boolean {
  return !(point.lng > 73.66 && point.lng < 135.05 && point.lat > 3.86 && point.lat < 53.55);
}

function transformLat(lng: number, lat: number): number {
  let ret =
    -100.0 +
    2.0 * lng +
    3.0 * lat +
    0.2 * lat * lat +
    0.1 * lng * lat +
    0.2 * Math.sqrt(Math.abs(lng));
  ret += ((20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(lat * Math.PI) + 40.0 * Math.sin((lat / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret +=
    ((160.0 * Math.sin((lat / 12.0) * Math.PI) + 320 * Math.sin((lat * Math.PI) / 30.0)) * 2.0) /
    3.0;
  return ret;
}

function transformLng(lng: number, lat: number): number {
  let ret =
    300.0 +
    lng +
    2.0 * lat +
    0.1 * lng * lng +
    0.1 * lng * lat +
    0.1 * Math.sqrt(Math.abs(lng));
  ret += ((20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(lng * Math.PI) + 40.0 * Math.sin((lng / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret +=
    ((150.0 * Math.sin((lng / 12.0) * Math.PI) + 300.0 * Math.sin((lng / 30.0) * Math.PI)) * 2.0) /
    3.0;
  return ret;
}

export function wgs84ToGcj02(point: LatLng): LatLng {
  if (outOfChina(point)) return point;
  let dLat = transformLat(point.lng - 105.0, point.lat - 35.0);
  let dLng = transformLng(point.lng - 105.0, point.lat - 35.0);
  const radLat = toRad(point.lat);
  let magic = Math.sin(radLat);
  magic = 1 - GCJ02_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ02_SEMI_MAJOR * (1 - GCJ02_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((GCJ02_SEMI_MAJOR / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: point.lat + dLat, lng: point.lng + dLng };
}

/** 高德所有坐标都是 "经度,纬度" 字符串，顺序与本项目 LatLng 相反。 */
export function parseAmapLocation(location: unknown): LatLng | null {
  if (typeof location !== "string") return null;
  const [lngText, latText] = location.split(",");
  const lng = Number(lngText);
  const lat = Number(latText);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng === 0 && lat === 0) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

export function formatLatLng(point: LatLng): string {
  return `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
}
