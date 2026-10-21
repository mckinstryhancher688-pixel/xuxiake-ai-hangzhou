"use client";

import { useCallback, useEffect, useState } from "react";
import { createFlyAiClient } from "@/lib/adapters";
import {
  DEFAULT_DISCOVER_CATEGORIES,
  DISCOVER_ENDPOINT,
  FLYAI_POI_CATEGORIES,
  MAX_CATEGORIES_PER_CALL,
  type FlyAiPoiCategory,
  type FlyAiServerStatus,
} from "@/lib/discovery";
import { createMockDiscoverBatch } from "@/data/mock";
import type { DiscoverBatch } from "@/lib/types";

export type DiscoverPhase = "idle" | "loading" | "live" | "failed" | "mock";

const flyai = createFlyAiClient();

/**
 * 只负责「手动触发 → 展示真实 POI 候选」。
 * 这里的数据不进地图、不改动行程：坐标未经高德核实前不参与任何路线计算。
 */
export function useDiscover(cityName: string) {
  const [selected, setSelected] = useState<FlyAiPoiCategory[]>([
    ...DEFAULT_DISCOVER_CATEGORIES,
  ]);
  const [phase, setPhase] = useState<DiscoverPhase>("idle");
  const [batch, setBatch] = useState<DiscoverBatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<FlyAiServerStatus | null>(null);

  const fetchStatus = useCallback(async (): Promise<FlyAiServerStatus | null> => {
    try {
      const response = await fetch(DISCOVER_ENDPOINT);
      return response.ok ? ((await response.json()) as FlyAiServerStatus) : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchStatus]);

  const toggleCategory = useCallback((category: FlyAiPoiCategory) => {
    setSelected((prev) => {
      if (prev.includes(category)) {
        // 至少留一个类别，否则「重新发现」没有查询目标
        return prev.length === 1 ? prev : prev.filter((item) => item !== category);
      }
      if (prev.length >= MAX_CATEGORIES_PER_CALL) return prev;
      return [...prev, category];
    });
  }, []);

  const rediscover = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const result = await flyai.searchPoi({ cityName, categories: selected });
      setBatch(result);
      if (result.ok) {
        setPhase("live");
      } else {
        setPhase("failed");
        setError(result.error ?? "飞猪没有返回可用数据。");
      }
    } catch (caught) {
      setBatch(null);
      setPhase("failed");
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      // 调用结束后刷新服务端计数，页面上能直接看到缓存项与真实调用次数的变化
      setStatus(await fetchStatus());
    }
  }, [cityName, fetchStatus, selected]);

  /** 失败后由用户显式切回演示数据，绝不静默替换。 */
  const fallbackToMock = useCallback(() => {
    setBatch(createMockDiscoverBatch(cityName, selected));
    setPhase("mock");
    setError(null);
  }, [cityName, selected]);

  return {
    categories: FLYAI_POI_CATEGORIES,
    maxCategories: MAX_CATEGORIES_PER_CALL,
    selected,
    toggleCategory,
    phase,
    batch,
    error,
    status,
    rediscover,
    fallbackToMock,
  };
}

export type Discover = ReturnType<typeof useDiscover>;
