"use client";

import { useCallback, useEffect, useState } from "react";
import { createAmapClient } from "@/lib/adapters";
import type { FlyAiPoiCategory } from "@/lib/discovery";
import {
  ROUTE_SNAPSHOT_KEY,
  saveSnapshot,
  useSessionSnapshot,
} from "@/lib/session-snapshot";
import {
  DEFAULT_VERIFY_CATEGORIES,
  VERIFY_ENDPOINT,
  type AmapServerStatus,
} from "@/lib/verification";
import type { VerifyReport } from "@/lib/types";

/**
 * idle   还没点过
 * loading 服务端正在跑核验（一次会真实请求高德数十次）
 * done    拿到了报告——报告里可能是一条可行路线，也可能是 error / insufficiency
 * failed  连报告都没拿到（网络或服务端异常）
 */
export type VerifyPhase = "idle" | "loading" | "done" | "failed";

const amap = createAmapClient();

interface RouteSnapshot {
  cityName: string;
  report: VerifyReport;
  usedCategories: FlyAiPoiCategory[];
}

/**
 * 只负责「手动触发核验 → 展示真实结果」。
 * 核验产出的行程由 JourneyApp 交给地图渲染；这里不碰地图状态。
 */
export function useVerifiedRoute(cityName: string) {
  const [rawPhase, setRawPhase] = useState<VerifyPhase>("idle");
  /** 这一轮点出来的报告；还没点过时为 null，此时用快照里那一份 */
  const [override, setOverride] = useState<VerifyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AmapServerStatus | null>(null);
  /** 这次核验实际用的类别：界面上勾了哪几个，核验就用哪几个，不再各算一套。 */
  const [categories, setCategories] = useState<FlyAiPoiCategory[]>([
    ...DEFAULT_VERIFY_CATEGORIES,
  ]);

  // 快照走 useSyncExternalStore：服务端渲染拿到 null，水合完成后 React 自己换成本标签页的值，
  // 不需要「挂载后再 setState」，也不会出现首屏对不上再闪一下。
  const snapshot = useSessionSnapshot<RouteSnapshot>(ROUTE_SNAPSHOT_KEY);
  const usable =
    snapshot && snapshot.cityName === cityName && snapshot.report.itinerary ? snapshot : null;
  const report = override ?? usable?.report ?? null;
  const usedCategories = override ? categories : (usable?.usedCategories ?? categories);
  const restored = override === null && usable !== null;
  const phase: VerifyPhase = restored && rawPhase === "idle" ? "done" : rawPhase;

  useEffect(() => {
    if (!report?.itinerary) return;
    saveSnapshot(ROUTE_SNAPSHOT_KEY, { cityName, report, usedCategories });
  }, [cityName, report, usedCategories]);

  const fetchStatus = useCallback(async (): Promise<AmapServerStatus | null> => {
    try {
      const response = await fetch(VERIFY_ENDPOINT);
      return response.ok ? ((await response.json()) as AmapServerStatus) : null;
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

  const verify = useCallback(
    async (next?: FlyAiPoiCategory[]) => {
      const picked = next?.length ? next : [...DEFAULT_VERIFY_CATEGORIES];
      setCategories(picked);
      setRawPhase("loading");
      setError(null);
      try {
        setOverride(await amap.verifyRoute(cityName, picked));
        setRawPhase("done");
      } catch (caught) {
        // 这一次没跑成：不覆盖上一份成功的结果，页面继续显示已知路线，错误照样如实列出来
        setOverride(null);
        setRawPhase("failed");
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        // 跑完后刷新服务端计数，页面上能直接看到这次真实消耗了多少高德调用
        setStatus(await fetchStatus());
      }
    },
    [cityName, fetchStatus],
  );

  return { phase, report, error, status, verify, usedCategories, restored };
}

export type VerifiedRoute = ReturnType<typeof useVerifiedRoute>;
