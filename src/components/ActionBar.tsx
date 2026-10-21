import type { ExplorationStatus } from "@/hooks/useJourney";
import { formatMinutes } from "@/lib/format";
import type { RouteVariant } from "@/lib/types";

export function ActionBar({
  activePoiName,
  isActiveVisited,
  explorationStatus,
  routeId,
  remainingMinutes,
  totalMinutes,
  onArrived,
  onToggleRoute,
}: {
  activePoiName: string;
  isActiveVisited: boolean;
  explorationStatus: ExplorationStatus;
  routeId: RouteVariant;
  remainingMinutes: number;
  totalMinutes: number;
  onArrived: () => void;
  onToggleRoute: () => void;
}) {
  const loading = explorationStatus === "loading";
  const progress = Math.min(100, Math.round(((totalMinutes - remainingMinutes) / totalMinutes) * 100));

  return (
    <div className="rounded-2xl border border-line bg-card p-3 shadow-sm">
      <div className="flex items-center justify-between text-[11px] text-ink-500">
        <span>
          当前：<span className="font-medium text-ink-900">{activePoiName}</span>
        </span>
        <span>剩余 {formatMinutes(remainingMinutes)}</span>
      </div>

      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="时间进度"
      >
        <div
          className="h-full rounded-full bg-brand-600 transition-[width] duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
        <button
          type="button"
          onClick={onArrived}
          disabled={loading}
          className="rounded-xl bg-brand-700 px-4 py-3 text-sm font-medium text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "生成中…" : isActiveVisited ? "再看一次探索" : `我到了 · ${activePoiName}`}
        </button>

        <button
          type="button"
          onClick={onToggleRoute}
          className="rounded-xl border border-line bg-paper px-4 py-3 text-sm font-medium text-ink-700 transition hover:border-brand-500 hover:text-brand-700"
        >
          {routeId === "standard" ? "换一条演示路线" : "走完整路线"}
        </button>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-ink-300">
        这两个按钮作用于左侧「演示行程」：进度与文案都是阶段一预写的。
        真实的在场讲解与「少走一点」动态调整在上方「在场探索 · 百炼托管智能体」面板，走百炼 API。
      </p>
    </div>
  );
}
