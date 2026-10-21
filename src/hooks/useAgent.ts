"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAgentStatus, requestAgent } from "@/lib/agent-client";
import type {
  AdjustResponse,
  AgentServerStatus,
  ExploreResponse,
  VerifyReport,
} from "@/lib/types";

export type AgentPhase = "idle" | "loading" | "done";

interface AgentState {
  phase: AgentPhase;
  error: string | null;
}

/** 智能体正在真实生成的文字（未校验）＋已经等了多久，只用于进度反馈。 */
export interface LiveTurn {
  text: string;
  waitedMs: number;
  /** 浏览器发起请求的时刻，用来和服务端凭证里的 totalMs 对照 */
  startedAt: number | null;
}

const EMPTY_LIVE: LiveTurn = { text: "", waitedMs: 0, startedAt: null };

/**
 * 「我到了」与「少走一点」都走这里。
 * 会话票据（token）只存在内存里，用来让第二次提问延续同一条百炼会话；
 * 刷新页面就重开会话——这是刻意的，避免把会话标识写进 localStorage。
 */
export function useAgent(
  city: string,
  interests: string[],
  report: VerifyReport | null,
) {
  const [token, setToken] = useState<string | null>(null);
  const [pickedStopId, setPickedStopId] = useState<string | null>(null);
  const [arrived, setArrived] = useState<AgentState>({ phase: "idle", error: null });
  const [arrival, setArrival] = useState<ExploreResponse | null>(null);
  const [adjusted, setAdjusted] = useState<AgentState>({ phase: "idle", error: null });
  const [adjustment, setAdjustment] = useState<AdjustResponse | null>(null);
  const [status, setStatus] = useState<AgentServerStatus | null>(null);
  /** 用户手动确认过到达的站点（flyaiId）。只是模拟到达，不是真实 GPS。 */
  const [arrivedStopIds, setArrivedStopIds] = useState<string[]>([]);
  const [live, setLive] = useState<{ arrive: LiveTurn; shorten: LiveTurn }>({
    arrive: EMPTY_LIVE,
    shorten: EMPTY_LIVE,
  });

  useEffect(() => {
    let cancelled = false;
    void fetchAgentStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 当前生效的行程＝「少走一点」通过校验后的那一份，没有就是核验结果。
  // 地图、行程卡片、可点选的站全部以它为准，避免出现「界面一套、地图另一套」。
  const activeItinerary = adjustment?.itinerary ?? report?.itinerary ?? null;
  const stops = activeItinerary?.stops ?? [];
  const selectedStopId = stops.some((stop) => stop.flyaiId === pickedStopId)
    ? pickedStopId
    : (stops[0]?.flyaiId ?? null);

  const refreshStatus = useCallback(async () => {
    setStatus(await fetchAgentStatus());
  }, []);

  const startedAt = useRef<{ arrive: number; shorten: number }>({ arrive: 0, shorten: 0 });
  /** 一次点击＝一个付费回合。setState 是异步的，连点两下会发出两个回合，所以这里用 ref 同步挡住。 */
  const inFlight = useRef<{ arrive: boolean; shorten: boolean }>({ arrive: false, shorten: false });
  const busy = arrived.phase === "loading" || adjusted.phase === "loading";

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      setLive((prev) => ({
        arrive:
          prev.arrive.startedAt === null
            ? prev.arrive
            : { ...prev.arrive, waitedMs: Date.now() - prev.arrive.startedAt },
        shorten:
          prev.shorten.startedAt === null
            ? prev.shorten
            : { ...prev.shorten, waitedMs: Date.now() - prev.shorten.startedAt },
      }));
    }, 200);
    return () => clearInterval(timer);
  }, [busy]);

  const send = useCallback(
    async (intent: "arrive" | "shorten") => {
      if (inFlight.current[intent]) return;
      inFlight.current[intent] = true;
      const setState = intent === "arrive" ? setArrived : setAdjusted;
      const now = Date.now();
      startedAt.current[intent] = now;
      setLive((prev) => ({ ...prev, [intent]: { text: "", waitedMs: 0, startedAt: now } }));
      setState({ phase: "loading", error: null });
      try {
        const result = await requestAgent(
          { intent, cityName: city, stopId: selectedStopId, interests, token },
          (text) =>
            setLive((prev) => ({
              ...prev,
              [intent]: { ...prev[intent], text: prev[intent].text + text },
            })),
        );
        if (intent === "arrive") {
          setArrival(result as ExploreResponse);
          if (result.ok && selectedStopId) {
            setArrivedStopIds((prev) =>
              prev.includes(selectedStopId) ? prev : [...prev, selectedStopId],
            );
          }
        } else {
          setAdjustment(result as AdjustResponse);
        }
        if (typeof result.token === "string") setToken(result.token);
        setState({
          phase: "done",
          error: result.ok ? null : (result.error ?? "百炼没有返回结果。"),
        });
      } catch (caught) {
        setState({
          phase: "done",
          error: caught instanceof Error ? caught.message : String(caught),
        });
      } finally {
        inFlight.current[intent] = false;
        setLive((prev) => ({ ...prev, [intent]: EMPTY_LIVE }));
        await refreshStatus();
      }
    },
    [city, interests, refreshStatus, selectedStopId, token],
  );

  const arrive = useCallback(() => send("arrive"), [send]);
  const shorten = useCallback(() => send("shorten"), [send]);

  return {
    status,
    tokenMasked: status && token ? token.slice(0, 8) : null,
    activeItinerary,
    selectedStopId,
    selectStop: setPickedStopId,
    arrived,
    arrival,
    adjusted,
    adjustment,
    arrivedStopIds,
    live,
    arrive,
    shorten,
    /** 上一次是失败态才允许重试；重试就是再买一个回合，但不会把旅行状态推进两遍 */
    canRetryArrive: arrived.phase === "done" && arrived.error !== null,
    canRetryShorten: adjusted.phase === "done" && adjusted.error !== null,
    hasReport: stops.length > 0,
  };
}

export type AgentController = ReturnType<typeof useAgent>;
