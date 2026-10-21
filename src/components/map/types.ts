import type { LatLng } from "@/lib/types";

export type MapFeatureState = "upcoming" | "active" | "visited";

export interface MapFeature {
  id: string;
  name: string;
  /** start = 已核验行程的固定起点，只有真实地图需要区分它 */
  kind: "poi" | "metro" | "start";
  position: LatLng;
  /** 行程顺序，从 1 开始；地铁站不排序 */
  order?: number;
  state: MapFeatureState;
}

export interface MapRouteLine {
  id: string;
  /** 真实地图里这条线必须是高德导航折线的点；缺几何的路段根本不会被送进来 */
  points: LatLng[];
  state: "walked" | "upcoming";
}

export interface MapStreet {
  name: string;
  path: LatLng[];
}

/**
 * 地图视图契约。业务层只依赖这个接口，不依赖具体是 SVG 还是高德。
 * 接入高德时新写一个满足 MapViewProps 的 AmapJsMap，
 * 然后在 src/components/map/index.ts 里换掉导出即可，页面代码零改动。
 */
export interface MapViewProps {
  features: MapFeature[];
  routeLines: MapRouteLine[];
  lakeOutline: LatLng[];
  streets: MapStreet[];
  activeFeatureId: string | null;
  onSelectFeature: (id: string) => void;
}
