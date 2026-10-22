"use client";

import { AmapJsMap } from "./AmapJsMap";
import { MockSvgMap } from "./MockSvgMap";
import type { MapViewProps } from "./types";
import type { MapConfigState } from "@/hooks/useMapJsConfig";

export interface MapCanvasProps extends MapViewProps {
  /** verified = 已有高德核验行程，用真实底图；demo = 尚未核验，用演示行程 */
  scene: "verified" | "demo";
  mapConfig: MapConfigState;
  /** 高德没返回道路几何、地图上没画的路段 */
  undrawnLegs: string[];
  sdkFailure: string | null;
  onFailed: (reason: string) => void;
}

export interface MapMode {
  /** 此刻画在屏幕上的到底是不是高德真实底图 */
  real: boolean;
  fallbackReason: string | null;
}

/**
 * 地图的唯一决策点：什么时候敢用真实底图，什么时候必须退回演示模式。
 * 规则只有两条——行程必须是已核验的，服务端必须配齐 JS API Key 与安全密钥。
 * 图例和免责文案也要引用同一个结论，否则会出现「画的是示意图、写着真实地图」。
 */
export function mapMode(
  scene: "verified" | "demo",
  mapConfig: MapConfigState,
  sdkFailure: string | null,
): MapMode {
  const real =
    scene === "verified" && mapConfig.phase === "ready" && mapConfig.config !== null && !sdkFailure;
  if (real) return { real: true, fallbackReason: null };
  if (scene === "demo") {
    return {
      real: false,
      fallbackReason: "尚未做高德核验，这里是手绘示意底图，不是真实地图",
    };
  }
  return {
    real: false,
    fallbackReason:
      sdkFailure ??
      (mapConfig.phase === "loading"
        ? mapConfig.reason
        : (mapConfig.reason ?? "真实地图配置不可用，暂时显示示意底图")),
  };
}

export function MapCanvas({
  scene,
  mapConfig,
  undrawnLegs,
  sdkFailure,
  onFailed,
  lakeOutline,
  streets,
  features,
  routeLines,
  activeFeatureId,
  onSelectFeature,
}: MapCanvasProps) {
  const { real, fallbackReason } = mapMode(scene, mapConfig, sdkFailure);

  return (
    <div className="relative h-full w-full">
      {real && mapConfig.config ? (
        <AmapJsMap
          config={mapConfig.config}
          features={features}
          routeLines={routeLines}
          activeFeatureId={activeFeatureId}
          onSelectFeature={onSelectFeature}
          onFailed={onFailed}
        />
      ) : (
        <MockSvgMap
          features={features}
          routeLines={routeLines}
          lakeOutline={lakeOutline}
          streets={streets}
          activeFeatureId={activeFeatureId}
          onSelectFeature={onSelectFeature}
        />
      )}

      {fallbackReason && (
        <div className="pointer-events-none absolute top-3 right-3 max-w-[15rem] rounded-lg bg-amber-100/95 px-2.5 py-1.5 text-right ring-1 ring-amber-500/50">
          <p className="text-[10px] font-semibold text-amber-900">演示模式</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-amber-800">{fallbackReason}</p>
        </div>
      )}

      {scene === "verified" && undrawnLegs.length > 0 && (
        <p className="pointer-events-none absolute bottom-16 left-3 right-3 rounded-lg bg-ink-900/70 px-2.5 py-1.5 text-[10px] leading-relaxed text-white/90">
          高德未返回以下路段的道路几何，地图上不画它们（也不用直线代替）：{undrawnLegs.join("、")}
        </p>
      )}
    </div>
  );
}
