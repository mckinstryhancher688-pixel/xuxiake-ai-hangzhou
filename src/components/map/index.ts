/**
 * 业务层只依赖 MapView 这个契约（见 types.ts），不关心底下是示意 SVG 还是真实高德。
 * 真实底图与演示底图的切换条件全部在 MapCanvas 里。
 */
export { MapCanvas as MapView, mapMode } from "./MapCanvas";
export type { MapCanvasProps } from "./MapCanvas";
