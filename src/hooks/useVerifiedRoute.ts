"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import {
  beginVerification, canApplyVerification, categoriesForReport, createVerificationScope, reportForCity,
  type RouteSnapshot, type VerificationScope,
} from "@/lib/verification-view";

/**
 * idle   还没点过
 * loading 服务端正在跑核验（一次会真实请求高德数十次）
 * done    拿到了报告——报告里可能是一条可行路线，也可能是 error / insufficiency
 * failed  连报告都没拿到（网络或服务端异常）
 */
export type VerifyPhase = "idle" | "loading" | "done" | "failed";

const amap = createAmapClient();

interface VerificationView {
  cityName: string;
  owner: object;
  rawPhase: VerifyPhase;
  override: VerifyReport | null;
  error: string | null;
  requestedCategories: FlyAiPoiCategory[];
}

function emptyView(cityName: string, owner: object): VerificationView {
  return { cityName, owner, rawPhase: "idle", override: null, error: null, requestedCategories: [...DEFAULT_VERIFY_CATEGORIES] };
}

/**
 * 只负责「手动触发核验 → 展示真实结果」。
 * 核验产出的行程由 JourneyApp 交给地图渲染；这里不碰地图状态。
 */
export function useVerifiedRoute(cityName: string) {
  // 同一城市离开后再回来也是新作用域，不能恢复上次已取消请求的 loading/error。
  const owner = useMemo(() => ({ cityName }), [cityName]);
  const [view, setView] = useState<VerificationView>(() => emptyView(cityName, owner));
  const blank = useMemo(() => emptyView(cityName, owner), [cityName, owner]);
  const current = view.owner === owner ? view : blank;
  const { rawPhase, override, error, requestedCategories } = current;
  const [status, setStatus] = useState<AmapServerStatus | null>(null);
  const scopeRef = useRef<VerificationScope | null>(null);
  const statusSequence = useRef(0);

  useLayoutEffect(() => {
    const scope = createVerificationScope(cityName);
    scopeRef.current = scope;
    return () => { scope.closed = true; };
  }, [cityName]);

  // 快照走 useSyncExternalStore：服务端渲染拿到 null，水合完成后 React 自己换成本标签页的值，
  // 不需要「挂载后再 setState」，也不会出现首屏对不上再闪一下。
  const snapshot = useSessionSnapshot<RouteSnapshot>(ROUTE_SNAPSHOT_KEY);
  const report = reportForCity(cityName, override, snapshot);
  const usedCategories = useMemo(() => categoriesForReport(report, requestedCategories), [report, requestedCategories]);
  const restored = report !== null && report !== override;
  const phase: VerifyPhase = restored && rawPhase === "idle" ? "done" : rawPhase;

  useEffect(() => {
    if (!report?.itinerary) return;
    saveSnapshot(ROUTE_SNAPSHOT_KEY, { cityName, report, usedCategories });
  }, [cityName, report, usedCategories]);

  const fetchStatus = useCallback(async (): Promise<AmapServerStatus | null> => {
    try {
      const response = await fetch(VERIFY_ENDPOINT, { cache: "no-store" });
      return response.ok ? ((await response.json()) as AmapServerStatus) : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const sequence = ++statusSequence.current;
    void fetchStatus().then((next) => {
      if (!cancelled && sequence === statusSequence.current) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchStatus]);

  const verify = useCallback(
    async (next?: FlyAiPoiCategory[]) => {
      const scope = scopeRef.current;
      if (!scope || scope.cityName !== cityName) return;
      const request = beginVerification(scope);
      if (!request) return;
      const picked = [...(next?.length ? next : DEFAULT_VERIFY_CATEGORIES)];
      setView((previous) => canApplyVerification(scopeRef.current, request)
        ? { ...(previous.owner === owner ? previous : emptyView(cityName, owner)), requestedCategories: picked, rawPhase: "loading", error: null }
        : previous);
      try {
        const received = await amap.verifyRoute(cityName, picked);
        if (received.cityName !== cityName) throw new Error("核验返回的城市与本次请求不一致，已保留上一份报告。");
        setView((previous) => canApplyVerification(scopeRef.current, request)
          ? { ...previous, override: received, rawPhase: "done", error: null } : previous);
      } catch (caught) {
        // 这一次没跑成：不覆盖上一份成功的结果，页面继续显示已知路线，错误照样如实列出来
        setView((previous) => canApplyVerification(scopeRef.current, request)
          ? { ...previous, rawPhase: "failed", error: caught instanceof Error ? caught.message : String(caught) } : previous);
      } finally {
        // 跑完后刷新服务端计数，页面上能直接看到这次真实消耗了多少高德调用
        if (canApplyVerification(scopeRef.current, request)) {
          const sequence = ++statusSequence.current;
          const nextStatus = await fetchStatus();
          if (canApplyVerification(scopeRef.current, request) && sequence === statusSequence.current) setStatus(nextStatus);
        }
      }
    },
    [cityName, owner, fetchStatus],
  );

  return { phase, report, error, status, verify, usedCategories, requestedCategories, restored };
}

export type VerifiedRoute = ReturnType<typeof useVerifiedRoute>;
