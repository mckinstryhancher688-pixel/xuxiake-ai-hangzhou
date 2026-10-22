import { formatDistance, formatMinutes } from "@/lib/format";
import type { ExplorationStatus } from "@/hooks/useJourney";
import type { Poi, RouteLeg, RouteVariant } from "@/lib/types";

export function ItineraryPanel({
  routeLabel,
  routeSummary,
  totalWalkMeters,
  totalMinutes,
  pois,
  activePoi,
  visitedIds,
  legFrom,
  routeId,
  isActiveVisited,
  explorationStatus,
  onSelect,
  onArrive,
  onToggleRoute,
}: {
  routeLabel: string;
  routeSummary: string;
  totalWalkMeters: number;
  totalMinutes: number;
  pois: Poi[];
  activePoi: Poi;
  visitedIds: string[];
  legFrom: Map<string, RouteLeg>;
  routeId: RouteVariant;
  isActiveVisited: boolean;
  explorationStatus: ExplorationStatus;
  onSelect: (id: string) => void;
  onArrive: () => void;
  onToggleRoute: () => void;
}) {
  const arriving = explorationStatus === "loading";
  return (
    <section className="rounded-2xl border border-accent-500/40 bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">
            {routeLabel}
            <span className="ml-1.5 rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] font-medium text-accent-600">
              演示数据（Mock）
            </span>
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">{routeSummary}</p>
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap gap-2 text-[11px]">
        <Stat label="地点" value={`${pois.length} 个`} />
        <Stat label="步行" value={formatDistance(totalWalkMeters)} />
        <Stat label="含停留约" value={formatMinutes(totalMinutes)} />
        <Stat label="已完成" value={`${visitedIds.length}/${pois.length}`} />
      </dl>

      <ol className="mt-4">
        {pois.map((poi, index) => {
          const visited = visitedIds.includes(poi.id);
          const active = poi.id === activePoi.id;
          const leg = legFrom.get(poi.id);
          return (
            <li key={poi.id}>
              <button
                type="button"
                onClick={() => onSelect(poi.id)}
                aria-current={active}
                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${
                  active
                    ? "border-accent-500/60 bg-accent-50"
                    : "border-transparent bg-paper hover:border-line hover:bg-white"
                }`}
              >
                <span
                  className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                    visited
                      ? "bg-brand-600 text-white"
                      : active
                        ? "bg-accent-500 text-white"
                        : "border border-line bg-white text-ink-500"
                  }`}
                >
                  {visited ? "✓" : index + 1}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium text-ink-900">{poi.name}</span>
                    <span className="text-[11px] text-ink-300">{poi.subtitle}</span>
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-500">
                    <span className="rounded-md bg-white px-1.5 py-0.5 ring-1 ring-line">
                      停留 {poi.stayMinutes} 分钟
                    </span>
                    {poi.tags.slice(0, 2).map((tag) => (
                      <span key={tag} className="rounded-md bg-white px-1.5 py-0.5 ring-1 ring-line">
                        {tag}
                      </span>
                    ))}
                  </span>
                </span>
              </button>

              {leg && (
                <div className="ml-[1.4rem] flex gap-3 py-1.5 pl-3">
                  <span className="w-px shrink-0 bg-line" aria-hidden />
                  <p className="text-[11px] leading-relaxed text-ink-300">
                    步行 {leg.minutes} 分钟 · {formatDistance(leg.distanceMeters)}
                    {leg.note && <span className="block text-ink-300/80">{leg.note}</span>}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onArrive}
          disabled={arriving}
          className="rounded-lg border border-accent-500/50 bg-accent-500/10 px-3 py-1.5 text-[11px] font-medium text-accent-700 transition hover:bg-accent-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {arriving ? "演示讲解生成中…" : isActiveVisited ? "再看一次演示讲解" : `标记已到 · ${activePoi.name}`}
        </button>
        <button
          type="button"
          onClick={onToggleRoute}
          className="rounded-lg border border-line bg-paper px-3 py-1.5 text-[11px] font-medium text-ink-500 transition hover:bg-white"
        >
          {routeId === "standard" ? "换成少走一点的 3 站版" : "换回完整 4 站版"}
        </button>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-ink-300">
        这一整块是演示行程（Mock）：地点、停留与讲解都是预写的，用来对照真实链路，
        不参与高德核验，也不会画到真实地图上。
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-paper px-2 py-1 ring-1 ring-line">
      <dt className="text-[10px] text-ink-300">{label}</dt>
      <dd className="text-[11px] font-medium text-ink-700">{value}</dd>
    </div>
  );
}
