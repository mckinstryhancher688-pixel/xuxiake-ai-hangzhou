"use client";

import { useCallback, useState } from "react";
import type { VerifiedItinerary } from "@/lib/types";

/**
 * 「爸妈能走多远」——亲情场景的入口。
 *
 * 这里做的是事实层免费重解：核验已经付费测完全部步行段，改上限只是换个求解目标，
 * 不会再请求高德。响应里的 cost.newAmapCalls 由服务端前后比对计数后给出，不是前端自说自话。
 *
 * 判定权在服务端：前端只把 withinLimit 翻译成人话，绝不自己比较数字。
 */

export const RESOLVE_ENDPOINT = "/api/resolve";

interface Preset {
  label: string;
  sub: string;
  meters: number | null;
}

/**
 * 档位按当前真实路线长度推算，而不是写死 1.5/3 公里。
 * 西湖一圈的实测链常在 4~8 公里，写死「1.5 公里」会永远排不出——
 * 那不是产品克制，是坏档位。这里按比例给，保证至少有一档可行。
 */
function presetsFor(currentWalkMeters: number | null): Preset[] {
  if (!currentWalkMeters || currentWalkMeters <= 0) {
    return [
      { label: "少走点", sub: "比现在少一半", meters: 3000 },
      { label: "正常走", sub: "一小时内", meters: 4000 },
      { label: "不设限", sub: "能走多少算多少", meters: null },
    ];
  }
  const tight = Math.max(200, Math.round((currentWalkMeters * 0.65) / 100) * 100);
  const mild = Math.max(200, Math.round((currentWalkMeters * 0.85) / 100) * 100);
  return [
    { label: "少走点", sub: `约 ${(tight / 1000).toFixed(1)} 公里`, meters: tight },
    { label: "稍微少点", sub: `约 ${(mild / 1000).toFixed(1)} 公里`, meters: mild },
    { label: "不设限", sub: "能走多少算多少", meters: null },
  ];
}

interface Explanation {
  totalWalkMeters: number;
  limit: number | null;
  withinLimit: boolean;
  longestSegmentMeters: number;
  segmentLimit: number | null;
  withinSegmentLimit: boolean;
  verdict: string;
  whyDropped: { id: string | null; name: string; text: string }[];
  keptBecauseMust: string[];
  withoutLimit: { totalWalkMeters: number; stopCount: number } | null;
}

interface ResolveOk {
  ok: true;
  itinerary: VerifiedItinerary;
  explanation: Explanation;
  execution: { allowed: boolean; reason: string };
  cost: { newAmapCalls: number };
}

interface ResolveFail {
  ok: false;
  code: string;
  reason: string;
  suggestion: { maxWalkMeters: number; stopCount: number; totalWalkMeters: number } | null;
  cost?: { newAmapCalls: number };
}

/** 单段档位：按「当前最长一段」的一半 / 四分之三给，另加「不限」。 */
function segmentPresetsFor(currentLongest: number): Preset[] {
  const half = Math.max(200, Math.round((currentLongest * 0.5) / 50) * 50);
  const threeQuarters = Math.max(200, Math.round((currentLongest * 0.75) / 50) * 50);
  return [
    { label: "一小段", sub: `≤ ${half} 米`, meters: half },
    { label: "一段", sub: `≤ ${threeQuarters} 米`, meters: threeQuarters },
    { label: "不限", sub: "只要能走就行", meters: null },
  ];
}

export function WalkLimitPanel({
  factsId,
  currentWalkMeters,
  currentLongestSegmentMeters = null,
  onResolved,
}: {
  factsId: string | null;
  currentWalkMeters: number | null;
  /** 当前行程里最长的一段；用来给出「一口气能走多远」的档位 */
  currentLongestSegmentMeters?: number | null;
  onResolved?: (itinerary: VerifiedItinerary) => void;
}) {
  const [active, setActive] = useState<number | null | undefined>(undefined);
  const [activeSegment, setActiveSegment] = useState<number | null | undefined>(undefined);
  const [result, setResult] = useState<ResolveOk | null>(null);
  const [failure, setFailure] = useState<ResolveFail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = useCallback(
    async (meters: number | null, segmentMeters?: number | null) => {
      if (!factsId) {
        setError("还没有可复用的事实集，请先生成一次路线。");
        return;
      }
      setBusy(true);
      setError(null);
      setFailure(null);
      setActive(meters);
      if (segmentMeters !== undefined) setActiveSegment(segmentMeters);
      try {
        const response = await fetch(RESOLVE_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            factsId,
            maxWalkMeters: meters,
            ...(segmentMeters !== undefined ? { maxSegmentMeters: segmentMeters } : {}),
          }),
        });
        const body = (await response.json()) as ResolveOk | ResolveFail | { error?: string };
        if (!response.ok) {
          setError(("error" in body && body.error) || `重解失败（HTTP ${response.status}）。`);
          setResult(null);
          return;
        }
        if (body && "ok" in body && body.ok) {
          setResult(body as ResolveOk);
          setFailure(null);
          onResolved?.((body as ResolveOk).itinerary);
        } else {
          setFailure(body as ResolveFail);
          setResult(null);
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "重解请求失败。");
      } finally {
        setBusy(false);
      }
    },
    [factsId, onResolved],
  );

  return (
    <section className="rounded-2xl border border-line bg-card p-3 shadow-sm" aria-label="爸妈能走多远">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-700">爸妈能走多远？</h2>
        <span className="text-[10px] text-ink-400">改上限不再花钱</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
        路线已经用高德实测过了。这里只按你选的距离重新排，不会再请求高德。
        {currentWalkMeters !== null ? ` 当前全程 ${currentWalkMeters} 米。` : ""}
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        {presetsFor(currentWalkMeters).map((preset) => {
          const selected = active === preset.meters && !error;
          return (
            <button
              key={preset.label}
              type="button"
              disabled={busy || !factsId}
              onClick={() => void resolve(preset.meters)}
              className={`flex min-w-[92px] flex-1 flex-col rounded-xl border px-3 py-2 text-left transition ${
                selected
                  ? "border-brand-600 bg-brand-600/10 text-brand-700"
                  : "border-line bg-paper text-ink-700 hover:border-brand-600/40"
              } ${busy || !factsId ? "opacity-50" : ""}`}
            >
              <span className="text-xs font-semibold">{preset.label}</span>
              <span className="text-[10px] text-ink-500">{preset.sub}</span>
            </button>
          );
        })}
      </div>

      {/* 单段上限：总量够短，也可能中间有一段走不动，所以单独设一档 */}
      {currentLongestSegmentMeters !== null && currentLongestSegmentMeters > 0 && (
        <div className="mt-2 rounded-xl border border-line bg-paper px-2.5 py-2">
          <p className="text-[11px] font-semibold text-ink-700">一口气最多走多远？</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-ink-500">
            现在最长的一段是 {currentLongestSegmentMeters} 米。总量再短，中间有一段走不动也不行。
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {segmentPresetsFor(currentLongestSegmentMeters).map((option) => {
              const selected = activeSegment === option.meters;
              return (
                <button
                  key={option.label}
                  type="button"
                  disabled={busy || !factsId}
                  onClick={() => void resolve(active ?? currentWalkMeters, option.meters)}
                  className={`flex min-w-[70px] flex-1 flex-col rounded-lg border px-2 py-1.5 text-left transition ${
                    selected ? "border-brand-600 bg-brand-600/10 text-brand-700" : "border-line bg-card text-ink-700"
                  } ${busy || !factsId ? "opacity-50" : ""}`}
                >
                  <span className="text-[11px] font-semibold">{option.label}</span>
                  <span className="text-[9.5px] text-ink-500">{option.sub}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {busy && <p className="mt-2 text-[11px] text-ink-500">正在用已实测的路段重新排…</p>}

      {error && (
        <p className="mt-2 rounded-lg bg-red-500/5 px-2 py-1.5 text-[11px] text-red-600 ring-1 ring-red-500/20">{error}</p>
      )}

      {result && (
        <div className="mt-2 rounded-xl bg-paper px-3 py-2 ring-1 ring-line">
          <p className={`text-[12px] font-medium ${result.explanation.withinLimit ? "text-brand-700" : "text-red-600"}`}>
            {result.explanation.verdict}
          </p>
          <p className="mt-0.5 text-[10px] text-ink-400">
            本次重解新增高德调用：{result.cost.newAmapCalls} 次
            {result.cost.newAmapCalls === 0 ? "（复用已实测路段）" : ""}
          </p>
          {result.explanation.whyDropped.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {result.explanation.whyDropped.map((item) => (
                <li key={`${item.id ?? item.name}`} className="text-[10.5px] leading-relaxed text-ink-500">
                  · {item.text}
                </li>
              ))}
            </ul>
          )}
          {result.explanation.keptBecauseMust.length > 0 && (
            <p className="mt-1.5 text-[10.5px] text-ink-500">
              · 你点名要去的：{result.explanation.keptBecauseMust.join("、")}
            </p>
          )}
          {!result.execution.allowed && (
            <p className="mt-1.5 text-[10.5px] text-red-600">暂不能执行：{result.execution.reason}</p>
          )}
        </div>
      )}

      {failure && (
        <div className="mt-2 rounded-xl bg-amber-500/5 px-3 py-2 ring-1 ring-amber-500/25">
          <p className="text-[11.5px] leading-relaxed text-ink-700">{failure.reason}</p>
          <p className="mt-0.5 text-[10px] text-ink-400">
            本次重解新增高德调用：{failure.cost?.newAmapCalls ?? 0} 次
            {(failure.cost?.newAmapCalls ?? 0) === 0 ? "（复用已实测路段）" : ""}
          </p>
          {failure.suggestion && (
            <button
              type="button"
              onClick={() => void resolve(failure.suggestion!.maxWalkMeters)}
              className="mt-1.5 rounded-lg border border-line bg-paper px-2 py-1 text-[10.5px] text-brand-700"
            >
              按 {failure.suggestion.maxWalkMeters} 米再试（可排 {failure.suggestion.stopCount} 站）
            </button>
          )}
        </div>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-ink-400">
        只能调整「走多远」。要把没实测过的站加进来，需要另外付费补测，这里不会自动去测。
      </p>
    </section>
  );
}
