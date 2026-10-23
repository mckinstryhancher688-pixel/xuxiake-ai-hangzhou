"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAgentStatus, requestAgent } from "@/lib/agent-client";
import { parseCategories } from "@/lib/discovery";
import {
  saveSnapshot,
  useSessionSnapshot,
  AGENT_SNAPSHOT_KEY,
} from "@/lib/session-snapshot";
import { DEFAULT_VERIFY_CATEGORIES } from "@/lib/verification";
import type {
  AdjustResponse,
  AgentServerStatus,
  ExploreResponse,
  VerifyReport,
  VerifiedItinerary,
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

/** 刷新前这一段的状态。只存成功过的结果，失败提示不跨刷新保留。 */
interface AgentSnapshot {
  token: string | null;
  pickedStopId: string | null;
  arrivedStopIds: string[];
  arrival: ExploreResponse | null;
  adjustment: AdjustResponse | null;
}

/**
 * 「我到了」与「少走一点」都走这里。
 * 会话票据（token）只是浏览器侧的随机标识，真实的百炼 Session ID 永远留在服务端。
 * 进度会写进 sessionStorage（随标签页关闭即消失，不是 localStorage），
 * 这样刷新页面后还在同一趟旅行里，不用重新点一遍。
 */
export function useAgent(
  city: string,
  interests: string[],
  report: VerifyReport | null,
  /**
   * 双人模式：把这条协商的编号与本方凭据交给服务端，让它读双方确认的正式版本。
   * 不传就是单人链路，行为与之前完全一致。
   */
  plan: { planId: string; token: string; itinerary?: VerifiedItinerary } | null = null,
  /** 已进入双人协商但还没有可执行的正式版本：不能退回单人会话或旧调整。 */
  executionBlocked = false,
) {
  const [tokenOverride, setToken] = useState<string | null>(null);
  const [pickedOverride, setPickedStopId] = useState<string | null>(null);
  const [arrived, setArrived] = useState<AgentState>({ phase: "idle", error: null });
  const [arrivalOverride, setArrival] = useState<ExploreResponse | null>(null);
  const [adjusted, setAdjusted] = useState<AgentState>({ phase: "idle", error: null });
  const [adjustmentOverride, setAdjustment] = useState<AdjustResponse | null>(null);
  const [status, setStatus] = useState<AgentServerStatus | null>(null);
  /** 用户在本轮里手动确认过到达的站点（flyaiId）。只是模拟到达，不是真实 GPS。 */
  const [arrivedOverride, setArrivedStopIds] = useState<string[]>([]);
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
  // 刷新前的进度从 sessionStorage 快照里取（useSyncExternalStore：水合后才拿到值）。
  const snapshot = useSessionSnapshot<AgentSnapshot>(AGENT_SNAPSHOT_KEY);
  const token = tokenOverride ?? snapshot?.token ?? null;
  const pickedStopId = pickedOverride ?? snapshot?.pickedStopId ?? null;

  const reportKey = report?.itinerary?.stops.map((stop) => stop.flyaiId).join(",") ?? "";
  const anyAdjustment = adjustmentOverride ?? (snapshot?.adjustment?.ok ? snapshot.adjustment : null);
  // 重新核验得到的是另一条路线时，旧路线上的调整与讲解都不再对应屏幕上的站，整组当没有
  const stale = Boolean(anyAdjustment?.baseItineraryKey) && reportKey !== "" && anyAdjustment?.baseItineraryKey !== reportKey;
  const adjustment = stale || executionBlocked || plan !== null ? null : anyAdjustment;
  const activeItinerary = executionBlocked ? null : (plan?.itinerary ?? adjustment?.itinerary ?? report?.itinerary ?? null);
  const stops = activeItinerary?.stops ?? [];
  const narrationStops = stops.length ? stops : (report?.itinerary?.stops ?? []);
  const anyArrival = arrivalOverride ?? (snapshot?.arrival?.ok ? snapshot.arrival : null);
  const arrival =
    !executionBlocked && anyArrival && anyArrival.stopName && narrationStops.some((stop) => stop.name === anyArrival.stopName)
      ? anyArrival
      : null;
  const arrivedStopIds = useMemo(() => {
    const all = arrivedOverride.length ? arrivedOverride : (snapshot?.arrivedStopIds ?? []);
    const ids = new Set((activeItinerary?.stops ?? []).map((stop) => stop.flyaiId));
    return all.filter((id) => ids.has(id));
  }, [activeItinerary, arrivedOverride, snapshot]);
  /** 屏幕上这一段是本标签页刷新前跑出来的，不是这次点的 */
  const restored =
    (arrival !== null || adjustment !== null) &&
    arrived.phase === "idle" &&
    adjusted.phase === "idle";

  // 服务端只有按同样的类别重新核验，才会读到界面上这一条路线
  const categories = useMemo(() => {
    const parsed = parseCategories(report?.categories ?? []);
    return parsed.length ? parsed : [...DEFAULT_VERIFY_CATEGORIES];
  }, [report]);
  const selectedStopId = stops.some((stop) => stop.flyaiId === pickedStopId)
    ? pickedStopId
    : (stops[0]?.flyaiId ?? null);

  // 到达过的站列表每次渲染都是新数组，所以用内容当依赖，避免写入效果每帧都跑一遍
  const arrivedKey = arrivedStopIds.join(",");
  useEffect(() => {
    if (!token && !arrival && !adjustment && arrivedKey === "") return;
    saveSnapshot(AGENT_SNAPSHOT_KEY, {
      token,
      pickedStopId,
      arrivedStopIds: arrivedKey ? arrivedKey.split(",") : [],
      arrival,
      adjustment,
    });
  }, [adjustment, arrival, arrivedKey, pickedStopId, token]);

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
      if (executionBlocked || (plan && intent === "shorten")) {
        const setState = intent === "arrive" ? setArrived : setAdjusted;
        setState({ phase: "done", error: executionBlocked
          ? "双人方案尚未正式生效，请先确认同一版本。"
          : "双方确认版不能由单人调整，请在双人协商中提出新方案。" });
        return;
      }
      if (inFlight.current[intent]) return;
      inFlight.current[intent] = true;
      const setState = intent === "arrive" ? setArrived : setAdjusted;
      const now = Date.now();
      startedAt.current[intent] = now;
      setLive((prev) => ({ ...prev, [intent]: { text: "", waitedMs: 0, startedAt: now } }));
      setState({ phase: "loading", error: null });
      try {
        const result = await requestAgent(
          {
            intent,
            cityName: city,
            stopId: selectedStopId,
            interests,
            categories,
            token,
            planId: plan ? plan.planId : null,
          },
          (text) =>
            setLive((prev) => ({
              ...prev,
              [intent]: { ...prev[intent], text: prev[intent].text + text },
            })),
          plan ? plan.token : null,
        );
        if (intent === "arrive") {
          setArrival(result as ExploreResponse);
          if (result.ok && selectedStopId && !arrivedStopIds.includes(selectedStopId)) {
            setArrivedStopIds([...arrivedStopIds, selectedStopId]);
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
    [arrivedStopIds, categories, city, executionBlocked, interests, plan, refreshStatus, selectedStopId, token],
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
    restored,
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
