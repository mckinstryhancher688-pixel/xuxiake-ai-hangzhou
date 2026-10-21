"use client";

import { useEffect, useState } from "react";
import type { MapJsConfig } from "@/lib/types";

export const MAP_CONFIG_ENDPOINT = "/api/map-config";

export type MapConfigState =
  | { phase: "loading"; config: null; reason: string }
  | { phase: "ready"; config: MapJsConfig; reason: null }
  | { phase: "unconfigured"; config: MapJsConfig; reason: string }
  | { phase: "failed"; config: null; reason: string };

/**
 * 真实底图的前置条件：JS API Key 与安全密钥都在服务端配好。
 * 缺任何一项就如实回退到演示地图，不拿示意图冒充真实底图。
 */
export function useMapJsConfig(): MapConfigState {
  const [state, setState] = useState<MapConfigState>({
    phase: "loading",
    config: null,
    reason: "正在向服务端确认高德 JS API 配置…",
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(MAP_CONFIG_ENDPOINT, { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) {
            setState({
              phase: "failed",
              config: null,
              reason: `${MAP_CONFIG_ENDPOINT} 返回 HTTP ${response.status}，无法确认真实地图配置。`,
            });
          }
          return;
        }
        const config = (await response.json()) as MapJsConfig;
        if (cancelled) return;
        setState(
          config.ready
            ? { phase: "ready", config, reason: null }
            : {
                phase: "unconfigured",
                config,
                reason: `服务端缺少 ${config.missing.join("、")}，真实底图无法加载。`,
              },
        );
      } catch (caught) {
        if (cancelled) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        setState({ phase: "failed", config: null, reason: `读取地图配置失败：${message}` });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
