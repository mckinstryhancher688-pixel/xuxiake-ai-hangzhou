import type { ExplorationStatus } from "@/hooks/useJourney";
import type { ExplorationContent, Poi } from "@/lib/types";

export function ExplorePanel({
  poi,
  exploration,
  explorationStatus,
}: {
  poi: Poi;
  exploration: ExplorationContent | null;
  explorationStatus: ExplorationStatus;
}) {
  return (
    <section className="rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] tracking-wide text-ink-300">当前地点</p>
          <h2 className="mt-0.5 text-base font-semibold text-ink-900">{poi.name}</h2>
          <p className="text-xs text-ink-500">{poi.subtitle}</p>
        </div>
        <span className="shrink-0 rounded-lg bg-brand-50 px-2 py-1 text-[11px] text-brand-700">
          停留 {poi.stayMinutes} 分钟
        </span>
      </div>

      <p className="mt-2 text-[11px] text-ink-500">
        {poi.opening}
        {!poi.openingVerified && <span className="text-accent-600"> · 未经核实</span>}
      </p>

      <Block title="推荐理由">
        <p className="text-xs leading-relaxed text-ink-700">{poi.reason}</p>
      </Block>

      <Block title="一个有趣的发现">
        <p className="text-xs leading-relaxed text-ink-700">{poi.discovery}</p>
      </Block>

      {explorationStatus === "loading" && (
        <div className="mt-4 rounded-xl border border-line bg-paper p-3">
          <p className="flex items-center gap-2 text-xs text-ink-500">
            <span className="size-3 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
            正在生成在场探索内容…（Mock 延迟 450ms）
          </p>
          <div className="mt-3 space-y-2">
            <div className="h-2.5 w-11/12 animate-pulse rounded bg-line" />
            <div className="h-2.5 w-9/12 animate-pulse rounded bg-line" />
            <div className="h-2.5 w-10/12 animate-pulse rounded bg-line" />
          </div>
        </div>
      )}

      {explorationStatus === "idle" && (
        <p className="mt-4 rounded-xl border border-dashed border-line bg-paper px-3 py-2.5 text-[11px] leading-relaxed text-ink-300">
          到达这里之后点「我到了」，徐霞客 AI 会给出这个地方专属的探索内容。
          <br />
          这里是演示行程的预写 Mock 文案；已核验行程的真实讲解在上方「在场探索 · 百炼托管智能体」。
        </p>
      )}

      {exploration && explorationStatus === "ready" && (
        <div className="mt-4 rounded-xl border border-brand-100 bg-brand-50/60 p-3">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-brand-700 px-1.5 py-0.5 text-[10px] font-medium text-white">
              AI 探索
            </span>
            <span className="text-[10px] text-brand-700">Mock 内容 · 非模型实时生成</span>
          </div>

          <h3 className="mt-2 text-sm font-semibold text-ink-900">
            {exploration.arrivedHeadline}
          </h3>

          <ul className="mt-2 space-y-1.5">
            {exploration.discoveries.map((item) => (
              <li key={item} className="flex gap-2 text-xs leading-relaxed text-ink-700">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-brand-500" />
                {item}
              </li>
            ))}
          </ul>

          <p className="mt-3 rounded-lg bg-white/70 px-2.5 py-2 text-[11px] leading-relaxed text-ink-700">
            <span className="font-medium text-brand-700">拍摄建议 · </span>
            {exploration.photoTip}
          </p>

          {exploration.askNext.length > 0 && (
            <p className="mt-2 text-[11px] leading-relaxed text-ink-300">
              可以继续问：{exploration.askNext.join(" ／ ")}
              <span className="block">（示例文案，本阶段未接入对话能力）</span>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 border-t border-line pt-3">
      <h3 className="text-[11px] font-medium tracking-wide text-ink-300">{title}</h3>
      <div className="mt-1">{children}</div>
    </div>
  );
}
