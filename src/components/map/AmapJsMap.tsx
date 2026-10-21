"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MapJsConfig } from "@/lib/types";
import type { MapFeature, MapRouteLine } from "./types";

const JSAPI_VERSION = "2.0";
const PLUGINS = ["AMap.Scale", "AMap.ToolBar"];
// 高德按四边留白避让；这里保持四边相同，不依赖它的参数顺序。
const FIT_PADDING = [56, 56, 56, 56];

/**
 * 只声明本项目真正用到的那部分高德命名空间。
 * Loader 的返回值是 any，收进这个接口后组件内部就不再有无类型的 any 了。
 */
interface AMapLngLat {
  lng: number;
  lat: number;
}
interface AMapOverlay {
  hide?(): void;
  show?(): void;
}
interface AMapMarkerLike extends AMapOverlay {
  on(event: string, handler: () => void): void;
}
interface AMapSdk {
  LngLat: new (lng: number, lat: number) => AMapLngLat;
  Pixel: new (x: number, y: number) => unknown;
  Marker: new (options: Record<string, unknown>) => AMapMarkerLike;
  Polyline: new (options: Record<string, unknown>) => AMapOverlay;
  Scale: new (options?: Record<string, unknown>) => unknown;
  ToolBar: new (options?: Record<string, unknown>) => unknown;
  Map: new (element: HTMLElement, options: Record<string, unknown>) => AMapMapInstance;
}
interface AMapMapInstance {
  add(overlays: AMapOverlay | AMapOverlay[]): void;
  remove(overlays: AMapOverlay | AMapOverlay[]): void;
  clearMap(): void;
  destroy(): void;
  setCenter(center: AMapLngLat, immediately?: boolean): void;
  resize?(): void;
  setFitView(overlays: AMapOverlay[] | null, immediately: boolean, padding: number[]): void;
  addControl(control: unknown): void;
}

declare global {
  interface Window {
    /** 高德官方的安全密钥代理配置项 */
    _AMapSecurityConfig?: { serviceHost: string };
  }
}

/** SDK 脚本是全局单例，重复挂载组件不会再注入一次 script。 */
let sdkPromise: Promise<AMapSdk> | null = null;

function loadSdk(config: MapJsConfig): Promise<AMapSdk> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      if (!config.jsKey) throw new Error("服务端没有给出高德 JS API Key");
      // 官方 Loader 在模块求值阶段就碰 window，所以必须等到浏览器里再动态引入，
      // 否则 Next.js 服务端渲染直接 ReferenceError: window is not defined。
      const { load } = await import("@amap/amap-jsapi-loader");
      // 先设代理地址再加载：SDK 的 web 服务请求会打到同源代理，jscode 只在服务端补。
      // 配置给的是相对路径，这里按浏览器自己的 origin 解析成绝对地址。
      window._AMapSecurityConfig = {
        serviceHost: new URL(config.securityHost, window.location.origin).href,
      };
      return (await load({
        key: config.jsKey,
        version: JSAPI_VERSION,
        plugins: PLUGINS,
      })) as AMapSdk;
    })();
    sdkPromise.catch(() => {
      sdkPromise = null;
    });
  }
  return sdkPromise;
}

const TONE = {
  start: { background: "#1f2937", color: "#ffffff", label: "起" },
  visited: { background: "#0d9488", color: "#ffffff", label: "" },
  active: { background: "#f59e0b", color: "#ffffff", label: "" },
  upcoming: { background: "#ffffff", color: "#334155", label: "" },
} as const;

function toneOf(feature: MapFeature): keyof typeof TONE {
  if (feature.kind === "start") return "start";
  if (feature.state === "active") return "active";
  if (feature.state === "visited") return "visited";
  return "upcoming";
}

function markerHtml(feature: MapFeature): string {
  const tone = TONE[toneOf(feature)];
  const badge = feature.kind === "start" ? tone.label : String(feature.order ?? "");
  const ring = toneOf(feature) === "active" ? "box-shadow:0 0 0 3px rgba(245,158,11,.35);" : "";
  const border = tone.background === "#ffffff" ? "border:1.5px solid #94a3b8;" : "";
  // 标记内容会被高德当 HTML 注入，补上 role/aria-label 后读屏和自动化才认得出这是个按钮。
  return (
    '<div role="button" aria-label="' +
    escapeHtml(`${badge ? `${badge} ` : ""}${feature.name}`) +
    '" style="display:flex;flex-direction:column;align-items:center;gap:2px;font-family:ui-sans-serif,system-ui;">' +
    `<span style="display:grid;place-items:center;width:22px;height:22px;border-radius:9999px;` +
    `font-size:11px;font-weight:700;line-height:1;background:${tone.background};color:${tone.color};${border}${ring}">${badge}</span>` +
    `<span style="max-width:96px;padding:1px 5px;border-radius:6px;background:rgba(255,255,255,.92);` +
    `font-size:10px;font-weight:${toneOf(feature) === "active" ? 700 : 500};color:#111827;` +
    `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(feature.name)}</span>` +
    "</div>"
  );
}

/** 标记内容会被当作 HTML 交给高德，POI 名称来自外部数据，必须先转义。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface AmapJsMapProps {
  config: MapJsConfig;
  features: MapFeature[];
  routeLines: MapRouteLine[];
  activeFeatureId: string | null;
  onSelectFeature: (id: string) => void;
  onFailed: (reason: string) => void;
}

/**
 * 真实高德地图。只负责底图、标记与折线显示；
 * 到达状态仍是用户手动点「我到了」模拟的，本组件不取真实 GPS，也不会调用百炼。
 */
export function AmapJsMap({
  config,
  features,
  routeLines,
  activeFeatureId,
  onSelectFeature,
  onFailed,
}: AmapJsMapProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const sdkRef = useRef<{ sdk: AMapSdk; map: AMapMapInstance } | null>(null);
  const overlaysRef = useRef<AMapOverlay[]>([]);
  const fittedSignature = useRef<string>("");
  const pendingFitRef = useRef(false);
  const featuresRef = useRef<MapFeature[]>(features);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");

  const fail = useCallback(
    (reason: string) => {
      setPhase("failed");
      onFailed(reason);
    },
    [onFailed],
  );

  // 全览要有真实容器尺寸才算得准：容器被 hidden（或宿主窗口被压成一条）时尺寸接近 0，
  // 高德会据此算出一个离谱的层级，而且之后不会自己纠正。
  const fitToOverlays = useCallback(() => {
    const engine = sdkRef.current;
    const holder = holderRef.current;
    if (!engine || !holder || holder.clientHeight < 120 || overlaysRef.current.length === 0) {
      return false;
    }
    engine.map.resize?.();
    engine.map.setFitView(overlaysRef.current, false, FIT_PADDING);
    return true;
  }, []);

  // 1. 加载 SDK 并建图；卸载时销毁实例，避免重复初始化
  useEffect(() => {
    let disposed = false;
    let map: AMapMapInstance | null = null;

    loadSdk(config)
      .then((sdk) => {
        if (disposed || !holderRef.current) return;
        const first = features[0]?.position;
        map = new sdk.Map(holderRef.current, {
          zoom: 14,
          center: first ? new sdk.LngLat(first.lng, first.lat) : undefined,
          mapStyle: "amap://styles/normal",
          viewMode: "2D",
          resizeEnable: true,
          dragEnable: true,
          zoomEnable: true,
          touchZoomEnable: true,
        });
        map.addControl(new sdk.Scale({ visible: true }));
        map.addControl(new sdk.ToolBar({ visible: true }));
        sdkRef.current = { sdk, map };
        setPhase("ready");
      })
      .catch((caught: unknown) => {
        if (disposed) return;
        // 高德 loader 在脚本请求失败时 reject 的是原生 Event（不是 Error），
        // 直接 String() 只会得到「[object Event]」这种用户读不懂的碎片。
        const detail =
          caught instanceof Error
            ? caught.message
            : caught instanceof Event
              ? "脚本请求没有成功（网络不通，或 Key 与安全密钥不匹配被平台拒绝）"
              : String(caught);
        fail(`高德地图 JS API 加载失败：${detail.slice(0, 160)}。已退回手绘示意底图，上面不画伪造的真实路线。`);
      });

    return () => {
      disposed = true;
      overlaysRef.current = [];
      sdkRef.current = null;
      // 销毁实例会连带清掉所有覆盖物，这是防止残留的唯一出口
      map?.destroy();
    };
    // features 只用来取初始中心，不参与依赖：建图一次就够
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, fail]);

  // 2. 数据变化 → 先整体移除上一批覆盖物再重画，杜绝覆盖物累积
  useEffect(() => {
    const engine = sdkRef.current;
    if (!engine || phase !== "ready") return;
    const { sdk, map } = engine;

    if (overlaysRef.current.length) map.remove(overlaysRef.current);
    overlaysRef.current = [];

    const next: AMapOverlay[] = [];

    for (const line of routeLines) {
      if (line.points.length < 2) continue;
      next.push(
        new sdk.Polyline({
          path: line.points.map((point) => new sdk.LngLat(point.lng, point.lat)),
          strokeColor: line.state === "walked" ? "#0d9488" : "#4b5563",
          strokeWeight: line.state === "walked" ? 6 : 5,
          strokeOpacity: line.state === "walked" ? 0.95 : 0.75,
          strokeStyle: line.state === "walked" ? "solid" : "dashed",
          isOutline: true,
          outlineColor: "#ffffff",
          lineJoin: "round",
          lineCap: "round",
          showDir: line.state === "upcoming",
          zIndex: 40,
        }),
      );
    }

    for (const feature of features) {
      const marker = new sdk.Marker({
        position: new sdk.LngLat(feature.position.lng, feature.position.lat),
        content: markerHtml(feature),
        anchor: "center",
        title: feature.name,
        zIndex: toneOf(feature) === "active" ? 130 : 110,
      });
      if (feature.kind !== "start" && feature.kind !== "metro") {
        marker.on("click", () => onSelectFeature(feature.id));
      }
      next.push(marker);
    }

    map.add(next);
    overlaysRef.current = next;

    // 站点集合真的变了才自动全览，平时不打断用户自己拖动的视角
    const signature = features.map((f) => f.id).join("|");
    if (signature !== fittedSignature.current) {
      fittedSignature.current = signature;
      pendingFitRef.current = !fitToOverlays();
    }
  }, [features, fitToOverlays, onSelectFeature, phase, routeLines]);

  // 3. 右侧点了哪个地点，地图就定位过去（只是移动视野，不发起任何外部调用）
  // 只跟着「选中的站真的换了」走：晚到的道路几何、父组件重渲染都不该把用户刚拖动的视角拽回去，
  // 所以这里不依赖 features，坐标从 ref 里取最新的那份。
  useEffect(() => {
    featuresRef.current = features;
  }, [features]);

  useEffect(() => {
    const engine = sdkRef.current;
    if (!engine || phase !== "ready" || !activeFeatureId) return;
    const target = featuresRef.current.find((feature) => feature.id === activeFeatureId);
    if (!target) return;
    // 手动点选之后就不再欠一次全览，否则切回地图时总览会把这一站又居中掉。
    pendingFitRef.current = false;
    engine.map.setCenter(new engine.sdk.LngLat(target.position.lng, target.position.lat));
  }, [activeFeatureId, phase]);

  // 4. 容器从 0 尺寸恢复成可见（移动端在「地图 / 行程」之间切换）时，补上欠的那次全览
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // display:none → 可见时高德不会自己重算画布尺寸，这里补一次 resize；
      // 欠着的全览只在容器真的有高度之后才执行，避免算出离谱层级。
      sdkRef.current?.map.resize?.();
      if (pendingFitRef.current && fitToOverlays()) pendingFitRef.current = false;
    });
    observer.observe(holder);
    return () => observer.disconnect();
  }, [fitToOverlays]);

  return (
    <div className="relative h-full w-full">
      <div ref={holderRef} className="h-full w-full" />
      {phase === "loading" && (
        <div className="absolute inset-0 grid place-items-center bg-paper/80">
          <p className="text-[11px] leading-relaxed text-ink-500">
            正在加载高德地图 JS API 2.0 底图…
            <span className="mt-1 block text-[10px] text-ink-300">
              安全密钥走服务端代理，浏览器不会拿到它
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
