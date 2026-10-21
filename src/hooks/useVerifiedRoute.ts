"use client";

import { useCallback, useEffect, useState } from "react";
import { createAmapClient } from "@/lib/adapters";
import { VERIFY_ENDPOINT, type AmapServerStatus } from "@/lib/verification";
import type { VerifyReport } from "@/lib/types";

/**
 * idle   还没点过
 * loading 服务端正在跑核验（一次会真实请求高德数十次）
 * done    拿到了报告——报告里可能是一条可行路线，也可能是 error / insufficiency
 * failed  连报告都没拿到（网络或服务端异常）
 */
export type VerifyPhase = "idle" | "loading" | "done" | "failed";

const amap = createAmapClient();

/**
 * 只负责「手动触发核验 → 展示真实结果」。
 * 核验产出的行程由 JourneyApp 交给地图渲染；这里不碰地图状态。
 */
export function useVerifiedRoute(cityName: string) {
  const [phase, setPhase] = useState<VerifyPhase>("idle");
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AmapServerStatus | null>(null);

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

  const verify = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const result = await amap.verifyRoute(cityName);
      setReport(result);
      setPhase("done");
    } catch (caught) {
      setReport(null);
      setPhase("failed");
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      // 跑完后刷新服务端计数，页面上能直接看到这次真实消耗了多少高德调用
      setStatus(await fetchStatus());
    }
  }, [cityName, fetchStatus]);

  return { phase, report, error, status, verify };
}

export type VerifiedRoute = ReturnType<typeof useVerifiedRoute>;
