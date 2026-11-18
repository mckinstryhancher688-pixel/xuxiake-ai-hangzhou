"use client";

import type { AgentController } from "@/hooks/useAgent";
import type { VerifiedRoute } from "@/hooks/useVerifiedRoute";
import { sameCategories, type FlyAiPoiCategory } from "@/lib/discovery";
import { PreflightQuestion } from "@/components/PreflightQuestion";

/**
 * 首屏就固定钉在底部的一条主流程按钮，手机上也一直可见：
 * 没路线时只有「生成我的路线」，出路线之后换成「我到了」（讲解）。
 * 这里不放任何技术说明——同一批动作在上方两个面板里各有详细版本，这里只负责「下一步点哪」。
 */
export function PlanActionBar({
  route,
  agent,
  categories,
  jointLocked = false,
  itineraryCategories,
  preflightMinutes,
  onPreflightChange,
}: {
  route: VerifiedRoute;
  agent: AgentController;
  categories: FlyAiPoiCategory[];
  /** 双方已经确认了正式版本：改选类别不会修改它 */
  jointLocked?: boolean;
  itineraryCategories: FlyAiPoiCategory[];
  /**
   * 生成路线之前先问的那一句：爸妈全程一共能走多久。
   * 三种状态不能混：undefined = 还没回答（任何按钮都不高亮）；null = 用户答了「不确定」；数字 = 分钟。
   */
  preflightMinutes?: number | null;
  onPreflightChange?: (minutes: number | null) => void;
}) {
  const itinerary = agent.activeItinerary;
  const stops = itinerary?.stops ?? [];
  const hasRoute = stops.length > 0;
  const verifying = route.phase === "loading";
  const agentBusy = agent.arrived.phase === "loading";
  const currentIndex = stops.findIndex((stop) => stop.flyaiId === agent.selectedStopId);
  const current = currentIndex >= 0 ? stops[currentIndex] : null;

  if (!hasRoute) {
    return (
      <Bar>
        {onPreflightChange && (
          <PreflightQuestion minutes={preflightMinutes} onChange={onPreflightChange} disabled={verifying} />
        )}
        <button
          type="button"
          onClick={() => void route.verify(categories)}
          disabled={verifying}
          className="w-full rounded-xl bg-brand-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {verifying ? "正在实测路线…" : "生成我的路线"}
        </button>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
          {verifying
            ? `正在核验「${route.requestedCategories.join(" + ")}」，请等待结果。成功结果会缓存，失败重试或缓存过期可能新增调用。`
            : `按「${categories.join(" + ")}」的飞猪候选，用高德逐段实测距离与耗时，挑出四小时内走得完的一条。`}
        </p>
      </Bar>
    );
  }

  return (
    <Bar>
      {!sameCategories(itineraryCategories, categories) && <p className="mb-2 rounded-lg bg-paper px-2 py-1.5 text-[11px] leading-relaxed text-ink-500">
        当前路线来自「{itineraryCategories.join(" + ")}」；已改选「{categories.join(" + ")}」。
        {jointLocked ? "改选不会修改双方确认版本。" : "新类别尚未生成，当前仍使用原路线。"}
      </p>}
      {/* 「少走一点」已删除（用户决定 D1）：它让托管智能体另给一条路线，不遵守用户定的分钟条件。
          想少走就在「调整」页把分钟调小，在已实测路段上重算，不花钱。 */}
      <button
        type="button"
        onClick={() => void agent.arrive()}
        disabled={agentBusy}
        className="w-full rounded-xl bg-accent-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {agent.arrived.phase === "loading" ? "讲解生成中…" : "我到了"}
      </button>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
        {current ? `正在看第 ${currentIndex + 1} 站 · ${current.name} · ` : ""}
        全程 {stops.length} 站 / {itinerary!.totalMinutes} 分钟，已确认到达 {agent.arrivedStopIds.length} 站
        （到达由你手动点，不是真实定位）。
      </p>
    </Bar>
  );
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-card/95 p-3 shadow-[0_-2px_12px_rgba(16,24,40,0.08)] backdrop-blur">
      {children}
    </div>
  );
}
