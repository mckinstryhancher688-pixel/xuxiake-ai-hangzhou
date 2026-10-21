"use client";

import { useCallback, useState } from "react";
import { MapView, mapMode } from "@/components/map";
import type { MapFeature, MapRouteLine, MapStreet } from "@/components/map/types";
import type { MapConfigState } from "@/hooks/useMapJsConfig";
import type { LatLng } from "@/lib/types";

const LEGEND = [
  { label: "已走过", swatch: "bg-brand-600" },
  { label: "当前地点", swatch: "bg-accent-500" },
  { label: "未走", swatch: "border border-ink-300 bg-white" },
] as const;

export function MapPanel({
  features,
  routeLines,
  lakeOutline,
  streets,
  activeFeatureId,
  onSelectFeature,
  disclaimer,
  scene,
  mapConfig,
  undrawnLegs,
}: {
  features: MapFeature[];
  routeLines: MapRouteLine[];
  lakeOutline: LatLng[];
  streets: MapStreet[];
  activeFeatureId: string | null;
  onSelectFeature: (id: string) => void;
  disclaimer: string;
  scene: "verified" | "demo";
  mapConfig: MapConfigState;
  undrawnLegs: string[];
}) {
  // SDK 加载失败只有地图组件知道，但图例也要说真话，所以状态放在这一层。
  const [sdkFailure, setSdkFailure] = useState<string | null>(null);
  const handleFailed = useCallback((reason: string) => setSdkFailure(reason), []);
  const { real } = mapMode(scene, mapConfig, sdkFailure);

  return (
    <section className="relative h-full overflow-hidden rounded-2xl border border-line bg-card shadow-sm">
      <div className="h-[52vh] min-h-[320px] w-full lg:h-full lg:min-h-[540px]">
        <MapView
          features={features}
          routeLines={routeLines}
          lakeOutline={lakeOutline}
          streets={streets}
          activeFeatureId={activeFeatureId}
          onSelectFeature={onSelectFeature}
          scene={scene}
          mapConfig={mapConfig}
          undrawnLegs={undrawnLegs}
          sdkFailure={sdkFailure}
          onFailed={handleFailed}
        />
      </div>

      {/* 窄屏地图只有半屏高，图例浮在上面会盖住标记；所以小屏让它排在地图下方，只有桌面端才悬浮。 */}
      <div className="pointer-events-none mx-3 mt-3 rounded-xl border border-line bg-card/90 px-3 py-2 text-[11px] text-ink-500 backdrop-blur lg:absolute lg:top-3 lg:left-3 lg:mx-0 lg:mt-0">
        <p className="text-[10px] font-semibold text-ink-900">
          {scene === "verified" ? "高德核验后的行程" : "演示行程（未核验）"}
        </p>
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {scene === "verified" && (
            <li className="flex items-center gap-2">
              <span className="grid size-2.5 place-items-center rounded-full bg-ink-900 text-[7px] text-white">
                起
              </span>
              西湖湖滨起点
            </li>
          )}
          {LEGEND.map((item) => (
            <li key={item.label} className="flex items-center gap-2">
              <span className={`size-2.5 rounded-full ${item.swatch}`} />
              {item.label}
            </li>
          ))}
          {scene === "demo" && (
            <li className="flex items-center gap-2">
              <span className="grid size-3 place-items rounded-sm border border-ink-500 text-[8px] text-ink-500">
                M
              </span>
              地铁站
            </li>
          )}
        </ul>
        <p className="mt-1.5 border-t border-line pt-1.5 text-[9px] leading-relaxed text-ink-300">
          {real
            ? "底图：高德 JS API 2.0 真实地图"
            : mapConfig.phase === "loading"
              ? "底图配置确认中…"
              : "底图：手绘示意（真实地图未启用）"}
        </p>
      </div>

      <p className="pointer-events-none mx-3 mt-2 mb-3 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-center text-[10px] leading-relaxed text-ink-500 sm:text-[11px] lg:absolute lg:right-3 lg:bottom-3 lg:left-3 lg:mx-0 lg:mt-0 lg:mb-0 lg:border-0 lg:bg-ink-900/70 lg:text-white/90 lg:backdrop-blur-sm">
        {disclaimer}
      </p>
    </section>
  );
}
