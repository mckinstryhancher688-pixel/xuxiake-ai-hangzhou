import type { LatLng } from "@/lib/types";

export interface Point {
  x: number;
  y: number;
}

export interface Projection {
  project(position: LatLng): Point;
}

/**
 * 把经纬度投到固定尺寸的平面坐标系（默认 100×100，配合 SVG viewBox 使用）。
 * 纬度 30° 附近 1° 经度只有约 96km，直接用经纬度当 x/y 会把东西向压扁，
 * 所以先按 cos(lat) 校正经度，再等比缩放居中。
 *
 * 这是纯函数，接高德底图后由地图 SDK 自己做投影，本文件可整体废弃。
 */
export function createProjection(
  points: LatLng[],
  width = 100,
  height = 100,
  padding = 10,
): Projection {
  const centerLat =
    points.reduce((sum, p) => sum + p.lat, 0) / Math.max(points.length, 1);
  const kx = Math.cos((centerLat * Math.PI) / 180);

  const xs = points.map((p) => p.lng * kx);
  const ys = points.map((p) => p.lat);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;

  return {
    project({ lat, lng }) {
      return {
        x: offsetX + (lng * kx - minX) * scale,
        // SVG 的 y 轴向下，纬度要翻转
        y: offsetY + (maxY - lat) * scale,
      };
    },
  };
}

export function projectPath(projection: Projection, path: LatLng[]): Point[] {
  return path.map((p) => projection.project(p));
}

export function toSvgPoints(points: Point[]): string {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}
