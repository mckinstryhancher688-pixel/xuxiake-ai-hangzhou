"use client";
import { useCallback, useState } from "react";
import type { VerifiedItinerary } from "@/lib/types";
import {
  DEFAULT_STAY_MINUTES,
  STAY_MINUTE_OPTIONS,
  WALK_MINUTE_OPTIONS,
  WALK_MINUTES_BASIS,
  billOf,
  minutesLabel,
  stayText,
} from "@/lib/walk-minutes";
/**
 * 「爸妈全程一共能走多久」——亲情场景唯一露出的一条条件。
 *
 * 这里做的是事实层免费重解：核验已经付费测完全部步行段，改上限只是换个求解目标，
 * 不会再请求高德。响应里的 cost.newAmapCalls 由服务端前后比对计数后给出，不是前端自说自话。
 *
 * 选项是一份固定菜单（见 lib/walk-minutes.ts），数字不由我们按路线长度推算；
 * 「不确定」就是不设上限，先看路线要走多久再自己调。
 * 判定权在服务端：前端只把 withinLimit 翻译成人话，绝不自己比较数字。
 */
export const RESOLVE_ENDPOINT = "/api/resolve";
interface Preset {
  label: string;
  sub: string;
  meters: number | null;
}
interface Explanation {
  totalWalkMeters: number;
  totalWalkMinutes: number;
  limit: number | null;
  limitMinutes: number | null;
  withinMinutesLimit: boolean;
  withinLimit: boolean;
  longestSegmentMeters: number;
  segmentLimit: number | null;
  withinSegmentLimit: boolean;
  verdict: string;
  whyDropped: { id: string | null; name: string; text: string }[];
  keptBecauseMust: string[];
  withoutLimit: { totalWalkMeters: number; totalWalkMinutes: number; stopCount: number } | null;
  stayMinutes: number;
  stayNote: string | null;
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
  suggestion: { maxWalkMinutes: number; maxWalkMeters: number; stopCount: number; totalWalkMeters: number; totalWalkMinutes: number } | null;
  cost?: { newAmapCalls: number };
}
/** 单段档位：按「当前最长一段」的一半 / 四分之三给，另加「不限」。只在 showSegmentLimit 打开时才会出现。 */
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
  currentWalkMinutes = null,
  currentLongestSegmentMeters = null,
  selectedMinutes,
  selectedStay = DEFAULT_STAY_MINUTES,
  showSegmentLimit = false,
  onResolved,
}: {
  factsId: string | null;
  currentWalkMeters: number | null;
  /** 当前行程的实测步行分钟（高德逐段累加），用来告诉用户「现在这条要走多久」 */
  currentWalkMinutes?: number | null;
  /** 当前行程里最长的一段；只在 showSegmentLimit 打开时用来给出「一口气能走多远」的档位 */
  currentLongestSegmentMeters?: number | null;
  /**
   * 用户已经回答过的那一档：undefined = 还没答；null = 答了「不确定」；数字 = 分钟。
   * 面板重新打开时据此恢复高亮，避免用户在生成前答过的话在这里「消失」。
   */
  selectedMinutes?: number | null;
  /** 当前的每站停留分钟（D2 开放的唯一第二档调节），默认 30 */
  selectedStay?: number;
  /**
   * 「一口气最多走多远」这一条目前不对用户露出（产品决定只保留一条）。
   * 求解器与接口仍支持单段上限，把它设为 true 就能原样恢复。
   */
  showSegmentLimit?: boolean;
  onResolved?: (
    itinerary: VerifiedItinerary,
    applied: { maxWalkMinutes: number | null | undefined; stayMinutes: number; maxSegmentMeters: number | null },
  ) => void;
}) {
  const [active, setActive] = useState<number | null | undefined>(selectedMinutes);
  const [activeStay, setActiveStay] = useState<number>(selectedStay);
  const [activeSegment, setActiveSegment] = useState<number | null | undefined>(undefined);
  const [result, setResult] = useState<ResolveOk | null>(null);
  const [failure, setFailure] = useState<ResolveFail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = useCallback(
    /**
     * minutes 保留三态：undefined = 用户还没答（只改停留时不能把它变成「不确定」），null = 不确定，数字 = 分钟。
     * 发给服务端时 undefined 与 null 都是「不设上限」。
     */
    async (minutes: number | null | undefined, stay: number, segmentMeters?: number | null) => {
      if (!factsId) {
        setError("还没有可复用的事实集，请先生成一次路线。");
        return;
      }
      setBusy(true);
      setError(null);
      setFailure(null);
      setActive(minutes);
      setActiveStay(stay);
      if (segmentMeters !== undefined) setActiveSegment(segmentMeters);
      try {
        const response = await fetch(RESOLVE_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            factsId,
            maxWalkMinutes: minutes ?? null,
            stayMinutes: stay,
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
          onResolved?.((body as ResolveOk).itinerary, {
            maxWalkMinutes: minutes,
            stayMinutes: stay,
            // 单段档位在调用处显式传入；未传时表示「不改单段」，回填 null 让上层知道当前没设这条限制
            maxSegmentMeters: segmentMeters !== undefined ? segmentMeters : null,
          });
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
    <section className="rounded-2xl border border-line bg-card p-3.5 shadow-card" aria-label="爸妈能走多久">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-sm font-bold text-brand-700">爸妈全程一共能走多久？</h2>
        <span className="rounded-full border border-zero-600/25 bg-zero-50 px-2.5 py-0.5 text-[10px] font-semibold text-zero-600">
          改上限不再花钱
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
        路线已经用高德实测过了。这里只按你选的时间重新排，不会再请求高德。
        {currentWalkMinutes !== null
          ? ` 当前全程步行约 ${currentWalkMinutes} 分钟${currentWalkMeters !== null ? `（${currentWalkMeters} 米）` : ""}。`
          : currentWalkMeters !== null
            ? ` 当前全程步行 ${currentWalkMeters} 米。`
            : ""}
      </p>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="全程步行上限">
        {/* 用户在首页用一句话说了菜单之外的时长（比如 45 分钟）：照样显示出来，不能让他的答案「消失」 */}
        {typeof active === "number" && !WALK_MINUTE_OPTIONS.some((option) => option.minutes === active) && (
          <span className="flex min-w-[72px] flex-1 flex-col rounded-xl border border-brand-600 bg-brand-600/10 px-3 py-2 text-left text-brand-700">
            <span className="text-xs font-semibold">{minutesLabel(active)}</span>
            <span className="text-[10px] text-ink-500">您说的</span>
          </span>
        )}
        {WALK_MINUTE_OPTIONS.map((option) => {
          const selected = active !== undefined && active === option.minutes && !error;
          return (
            <button
              key={option.label}
              type="button"
              disabled={busy || !factsId}
              onClick={() => void resolve(option.minutes, activeStay)}
              className={`flex min-w-[72px] flex-1 flex-col rounded-xl border px-3 py-2 text-left transition ${
                selected
                  ? "border-brand-600 bg-brand-600/10 text-brand-700"
                  : "border-line bg-paper text-ink-700 hover:border-brand-600/40"
              } ${busy || !factsId ? "opacity-50" : ""}`}
            >
              <span className="text-xs font-semibold">{option.label}</span>
              {option.sub && <span className="text-[10px] text-ink-500">{option.sub}</span>}
            </button>
          );
        })}
      </div>
      {/* 每站停留：D2 开放的唯一第二档调节；缓冲 20 分钟固定，不开放 */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="每站停留多久">
        <span className="text-[11px] font-medium text-ink-600">每站停留</span>
        {STAY_MINUTE_OPTIONS.map((stay) => {
          const selected = activeStay === stay && !error;
          return (
            <button
              key={stay}
              type="button"
              disabled={busy || !factsId}
              aria-pressed={selected}
              onClick={() => void resolve(active, stay)}
              className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                selected
                  ? "border-brand-600 bg-brand-600/10 text-brand-700"
                  : "border-line bg-paper text-ink-700 hover:border-brand-600/40"
              } ${busy || !factsId ? "opacity-50" : ""}`}
            >
              {stay} 分钟
            </button>
          );
        })}
        <span className="text-[10px] text-ink-400">缓冲 20 分钟固定</span>
      </div>
      {/* 单段上限：产品上先不露出（showSegmentLimit 默认 false）。总量够短，也可能中间有一段走不动，需要时再打开。 */}
      {showSegmentLimit && currentLongestSegmentMeters !== null && currentLongestSegmentMeters > 0 && (
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
                  onClick={() => void resolve(active, activeStay, option.meters)}
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
          <p
            className={`text-[12px] font-medium ${
              result.explanation.withinLimit && result.explanation.withinMinutesLimit ? "text-brand-700" : "text-red-600"
            }`}
          >
            {result.explanation.verdict}
          </p>
          {(() => {
            const bill = billOf(result.itinerary);
            return (
              <p className="mt-1 text-[10.5px] leading-relaxed text-ink-600" data-testid="resolve-bill">
                合计 {bill.total} / {bill.budget} 分钟 = 步行 {bill.walk} 分钟（高德实测）＋ 停留 {stayText(bill)}（模拟）＋ 缓冲 {bill.buffer} 分钟（固定）
              </p>
            );
          })()}
          {result.explanation.stayNote && (
            <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-500">· {result.explanation.stayNote}</p>
          )}
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
              onClick={() => void resolve(failure.suggestion!.maxWalkMinutes, activeStay)}
              className="mt-1.5 rounded-lg border border-line bg-paper px-2 py-1 text-[10.5px] text-brand-700"
            >
              按 {minutesLabel(failure.suggestion.maxWalkMinutes)} 再试（可排 {failure.suggestion.stopCount} 站）
            </button>
          )}
        </div>
      )}
      <p className="mt-2 text-[10px] leading-relaxed text-ink-400">
        {WALK_MINUTES_BASIS}只能调整「走多久」。要把没实测过的站加进来，需要另外付费补测，这里不会自动去测。
      </p>
    </section>
  );
}
