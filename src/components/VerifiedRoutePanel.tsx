import { formatDistance, formatMinutes } from "@/lib/format";
import type { VerifiedRoute, VerifyPhase } from "@/hooks/useVerifiedRoute";
import {
  MATCH_STATUS_LABELS,
  OPENING_STATUS_LABELS,
  SIMULATED_STAY_MINUTES,
} from "@/lib/verification";
import type {
  CandidateMatch,
  DatumConclusion,
  MatchStatus,
  OpeningStatus,
  RouteStart,
  VerifiedItinerary,
  VerifyReport,
} from "@/lib/types";

const PHASE_BADGE: Record<VerifyPhase, { label: string; className: string }> = {
  idle: { label: "未核验", className: "bg-paper text-ink-300 ring-1 ring-line" },
  loading: { label: "核验中…", className: "bg-accent-500/15 text-accent-600" },
  done: { label: "LIVE · 高德真实计算", className: "bg-brand-600/15 text-brand-700" },
  failed: { label: "核验失败", className: "bg-red-500/10 text-red-600" },
};

const MATCH_BADGE: Record<MatchStatus, string> = {
  matched: "bg-brand-600/15 text-brand-700",
  suspicious: "bg-accent-500/15 text-accent-600",
  unverified: "bg-ink-300/25 text-ink-500",
};

const OPENING_BADGE: Record<OpeningStatus, string> = {
  "open-24h": "bg-brand-600/15 text-brand-700",
  "no-conflict": "bg-brand-600/15 text-brand-700",
  conflict: "bg-red-500/10 text-red-600",
  unknown: "bg-accent-500/15 text-accent-600",
};

/** 三类数据来源必须一眼分得开，所以整块面板统一用这三个标签。 */
function SourceTag({ kind }: { kind: "flyai" | "amap" | "simulated" }) {
  const style =
    kind === "flyai"
      ? "bg-brand-600/10 text-brand-700"
      : kind === "amap"
        ? "bg-sky-500/15 text-sky-700"
        : "bg-ink-300/25 text-ink-500";
  const label = kind === "flyai" ? "飞猪" : kind === "amap" ? "高德" : "模拟";
  return (
    <span className={`rounded px-1 py-px text-[9px] font-medium ${style}`}>{label}</span>
  );
}

export function VerifiedRoutePanel({
  cityName,
  route,
  activeItinerary,
  routeAdjusted,
  selectedStopId,
  arrivedStopIds,
  onSelectStop,
}: {
  cityName: string;
  route: VerifiedRoute;
  activeItinerary: VerifiedItinerary | null;
  routeAdjusted: boolean;
  selectedStopId: string | null;
  arrivedStopIds: string[];
  onSelectStop: (id: string) => void;
}) {
  const badge = PHASE_BADGE[route.phase];
  const loading = route.phase === "loading";
  const report = route.report;
  // 主界面只有一份「当前生效路线」：智能体调整过就显示调整后的，与左侧地图完全一致。
  const shownItinerary = activeItinerary ?? report?.itinerary ?? null;

  return (
    <section className="rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">
            高德核验路线 · {cityName}
            四小时可行性
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            用高德 POI 搜索 2.0 核验飞猪候选的真实位置，再用步行路径规划 2.0
            算真实距离与耗时，最后在 240 分钟内挑出走得完的组合。
          </p>
        </div>
        <span className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-medium ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            void route.verify();
          }}
          disabled={loading}
          className="rounded-lg bg-brand-700 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "核验中，服务端正在真实请求高德…" : "开始核验（真实调用高德）"}
        </button>

        <span className="flex items-center gap-1.5 text-[10px] text-ink-300">
          <SourceTag kind="flyai" /> 地点信息
          <SourceTag kind="amap" /> 步行计算
          <SourceTag kind="simulated" /> 停留时间
        </span>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-ink-300">
        一次核验会让服务端真实请求高德约 60 次（POI 搜索 + 步行路径规划），结果整体缓存{" "}
        {route.status ? route.status.pipelineCacheTtlSeconds / 60 : 30} 分钟，
        重复点击不再产生新调用。停留时间统一按 {SIMULATED_STAY_MINUTES} 分钟的模拟值计算，
        飞猪与高德都不提供这个数据。
      </p>

      {route.error && (
        <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
          <p className="text-[11px] font-semibold text-red-600">
            核验失败 · 以下是服务端返回的真实错误
          </p>
          <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-ink-700">
            {route.error}
          </p>
        </div>
      )}

      {route.phase === "idle" && (
        <p className="mt-3 rounded-lg bg-paper px-2.5 py-2 text-[11px] leading-relaxed text-ink-300 ring-1 ring-line">
          还没有发起核验。左侧地图与上方行程仍是<strong className="font-semibold text-accent-600">演示数据（Mock）</strong>，
          未经高德验证；点「开始核验」后这里会给出真实路线。
        </p>
      )}

      {report && (
        <>
          <DatumLine datum={report.datum} />
          <CountLine report={report} />

          {report.start && <StartLine start={report.start} />}

          {report.error && (
            <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
              <p className="text-[11px] font-semibold text-red-600">核验没有跑完</p>
              <p className="mt-1 break-words text-[11px] leading-relaxed text-ink-700">
                {report.error}
              </p>
            </div>
          )}

          {report.insufficiency && (
            <div className="mt-3 rounded-xl border border-accent-500/40 bg-accent-50 p-3">
              <p className="text-[11px] font-semibold text-accent-600">
                候选不足 · 不会用假地点凑数
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-700">
                {report.insufficiency}
              </p>
            </div>
          )}

          {shownItinerary && (
            <>
              {routeAdjusted && (
                <p className="mt-3 rounded-lg bg-accent-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-accent-700">
                  下面是「少走一点」调整后的<strong className="font-semibold">当前生效路线</strong>，
                  左侧地图与时间合计都以它为准；调整前的原始核验记录保留在页面底部的开发调试面板里。
                </p>
              )}
              <Itinerary
                itinerary={shownItinerary}
                selectedStopId={selectedStopId}
                arrivedStopIds={arrivedStopIds}
                onSelectStop={onSelectStop}
              />
            </>
          )}

          <CandidateTable matches={report.matches} />
          <RejectionList report={report} />
        </>
      )}
    </section>
  );
}

function DatumLine({ datum }: { datum: DatumConclusion }) {
  return (
    <div className="mt-3 rounded-lg bg-paper px-2.5 py-2 ring-1 ring-line">
      <p className="text-[11px] font-medium text-ink-700">
        <SourceTag kind="amap" /> 坐标系判定：
        {datum.flyaiDatum ? (
          <span className="text-brand-700">飞猪用的就是 {datum.flyaiDatum.toUpperCase()}</span>
        ) : (
          <span className="text-accent-600">证据不足，未能判定</span>
        )}
        <span className="ml-1.5 font-normal text-ink-300">
          （用 {datum.probes.length} 个双方同名的地标实测比对，不是假定）
        </span>
      </p>
      <p className="mt-1 text-[10px] leading-relaxed text-ink-500">{datum.reason}</p>
      {datum.probes.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {datum.probes.map((probe) => (
            <li key={probe.landmarkName} className="font-mono text-[10px] text-ink-300">
              {probe.landmarkName}：当 GCJ-02 比对偏差 {probe.asGcj02Meters} 米 / 当 WGS-84
              转换后比对偏差 {probe.asWgs84Meters} 米
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CountLine({ report }: { report: VerifyReport }) {
  return (
    <dl className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
      <Chip label="飞猪候选" value={`${report.candidateCount} 条`} />
      <Chip label="已匹配" value={`${report.matchedCount}`} tone="brand" />
      <Chip label="可疑" value={`${report.suspiciousCount}`} tone="accent" />
      <Chip label="未验证" value={`${report.unverifiedCount}`} tone="ink" />
      <Chip label="可用于步行规划" value={`${report.routableCount}`} />
    </dl>
  );
}

function Chip({
  label,
  value,
  tone = "plain",
}: {
  label: string;
  value: string;
  tone?: "plain" | "brand" | "accent" | "ink";
}) {
  const style =
    tone === "brand"
      ? "text-brand-700"
      : tone === "accent"
        ? "text-accent-600"
        : tone === "ink"
          ? "text-ink-500"
          : "text-ink-700";
  return (
    <div className="rounded-lg bg-paper px-2 py-1 ring-1 ring-line">
      <dt className="text-[10px] text-ink-300">{label}</dt>
      <dd className={`text-[11px] font-medium ${style}`}>{value}</dd>
    </div>
  );
}

function StartLine({ start }: { start: RouteStart }) {
  return (
    <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
      <SourceTag kind="amap" /> 固定起点：<span className="font-medium text-ink-900">{start.name}</span>
      <span className="ml-1.5 font-mono text-[10px] text-ink-300">
        {start.position.lat.toFixed(6)},{start.position.lng.toFixed(6)}
      </span>
      <span className="mt-0.5 block text-[10px] text-ink-300">{start.reason}</span>
    </p>
  );
}

function Itinerary({
  itinerary,
  selectedStopId,
  arrivedStopIds,
  onSelectStop,
}: {
  itinerary: VerifiedItinerary;
  selectedStopId: string | null;
  arrivedStopIds: string[];
  onSelectStop: (id: string) => void;
}) {
  const assumedStart = new Date(itinerary.assumedStartAt);
  const arrived = new Set(arrivedStopIds);
  return (
    <div className="mt-3 rounded-xl border border-brand-600/30 bg-brand-50/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold text-ink-900">
          已核验的四小时步行行程 · {itinerary.stops.length} 站
        </h3>
        <span
          className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${
            itinerary.feasible
              ? "bg-brand-600 text-white"
              : "bg-red-500/15 text-red-600"
          }`}
        >
          {itinerary.feasible ? "四小时内可完成" : "超出四小时"}
        </span>
      </div>

      <dl className="mt-2 flex flex-wrap gap-1.5">
        <Chip label="合计" value={`${itinerary.totalMinutes} / ${itinerary.budgetMinutes} 分钟`} tone="brand" />
        <Chip label="步行（高德）" value={`${itinerary.totalWalkMinutes} 分钟 · ${formatDistance(itinerary.totalWalkMeters)}`} />
        <Chip label="停留（模拟）" value={`${itinerary.totalStayMinutes} 分钟`} />
        <Chip label="缓冲" value={`${itinerary.bufferMinutes} 分钟`} />
      </dl>

      <p className="mt-2 text-[10px] leading-relaxed text-ink-500">
        假定出发时间{" "}
        <span className="font-medium text-ink-700">
          {Number.isNaN(assumedStart.getTime())
            ? itinerary.assumedStartAt
            : assumedStart.toLocaleString("zh-CN", { hour12: false })}
        </span>
        （产品设定，用于判断营业时间冲突；不是实测时间）。步行数值全部来自高德路径规划，
        不是直线距离换算。
      </p>

      <ol className="mt-3">
        <li className="flex items-start gap-2 rounded-lg bg-white/70 px-2.5 py-2 ring-1 ring-line">
          <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand-700 text-[10px] font-semibold text-white">
            起
          </span>
          <span className="min-w-0 text-[12px] font-medium text-ink-900">
            {itinerary.start.name}
            <span className="ml-1.5">
              <SourceTag kind="amap" />
            </span>
            <span className="mt-0.5 block text-[10px] font-normal text-ink-300">
              {itinerary.start.address ?? "高德未返回地址"}
            </span>
          </span>
        </li>

        {itinerary.stops.map((stop, index) => {
          const leg = itinerary.legs[index];
          const isActive = stop.flyaiId === selectedStopId;
          return (
            <li key={stop.amapId || stop.flyaiId}>
              {leg && (
                <div className="ml-2.5 flex items-center gap-2 py-1.5 pl-3">
                  <span className="w-px shrink-0 self-stretch bg-line" aria-hidden />
                  <p className="text-[11px] leading-relaxed text-ink-500">
                    <SourceTag kind="amap" /> 步行 {leg.durationMinutes} 分钟 ·{" "}
                    {formatDistance(leg.distanceMeters)}
                    <span className="ml-1.5 text-[10px] text-ink-300">
                      {leg.stepCount} 段{leg.firstInstruction ? ` · ${leg.firstInstruction}` : ""}
                    </span>
                  </p>
                </div>
              )}

              <div
                className={`flex items-start gap-2 rounded-lg px-2.5 py-2 ${
                  isActive
                    ? "bg-accent-50 ring-2 ring-accent-500"
                    : "bg-white/70 ring-1 ring-line"
                }`}
              >
                <span
                  className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white ${
                    arrived.has(stop.flyaiId) ? "bg-brand-700" : "bg-accent-500"
                  }`}
                >
                  {arrived.has(stop.flyaiId) ? "✓" : index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span className="text-[12px] font-medium text-ink-900">{stop.name}</span>
                    <span className={`rounded px-1 py-px text-[9px] ${MATCH_BADGE[stop.matchStatus]}`}>
                      {MATCH_STATUS_LABELS[stop.matchStatus]}
                    </span>
                    <span className={`rounded px-1 py-px text-[9px] ${OPENING_BADGE[stop.openingStatus]}`}>
                      {OPENING_STATUS_LABELS[stop.openingStatus]}
                    </span>
                    {arrived.has(stop.flyaiId) && (
                      <span className="rounded bg-brand-700 px-1 py-px text-[9px] text-white">
                        已到达（手动模拟）
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => onSelectStop(stop.flyaiId)}
                      aria-pressed={isActive}
                      className={`ml-auto rounded px-1.5 py-0.5 text-[9px] font-medium ring-1 transition ${
                        isActive
                          ? "bg-accent-500 text-white ring-accent-500"
                          : "bg-white text-ink-500 ring-line hover:bg-paper"
                      }`}
                    >
                      {isActive ? "地图已定位" : "在地图定位"}
                    </button>
                  </span>

                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] leading-relaxed text-ink-500">
                    <span>
                      <SourceTag kind="amap" /> {stop.address ?? "高德未返回地址"}
                    </span>
                    <span>
                      <SourceTag kind="simulated" /> 停留 {stop.stayMinutes} 分钟
                    </span>
                    {stop.jumpUrl && (
                      <span>
                        <SourceTag kind="flyai" />
                        <a
                          href={stop.jumpUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-1 font-medium text-brand-700 underline underline-offset-2"
                        >
                          在飞猪查看 →
                        </a>
                      </span>
                    )}
                  </span>

                  <span className="mt-1 block text-[10px] leading-relaxed text-ink-300">
                    {stop.openingNote}
                  </span>
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="mt-2 text-[10px] leading-relaxed text-ink-500">
        合计 {formatMinutes(itinerary.totalMinutes)}：步行 {itinerary.totalWalkMinutes} 分钟（
        <SourceTag kind="amap" /> 高德实测）＋ 停留 {itinerary.totalStayMinutes} 分钟（
        <SourceTag kind="simulated" /> 每站 {SIMULATED_STAY_MINUTES} 分钟）＋ 缓冲{" "}
        {itinerary.bufferMinutes} 分钟，预算 {itinerary.budgetMinutes} 分钟。
      </p>
    </div>
  );
}

function CandidateTable({ matches }: { matches: CandidateMatch[] }) {
  if (!matches.length) return null;
  return (
    <details className="mt-3 rounded-lg bg-paper ring-1 ring-line">
      <summary className="cursor-pointer px-2.5 py-2 text-[11px] font-medium text-ink-700">
        {matches.length} 条飞猪候选的逐条核验结果
      </summary>
      <ul className="space-y-1.5 px-2.5 pb-2.5">
        {matches.map((match) => (
          <li key={match.flyaiId} className="rounded-lg bg-white/70 px-2 py-1.5 ring-1 ring-line">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="text-[11px] font-medium text-ink-900">{match.name}</span>
              <span className={`rounded px-1 py-px text-[9px] ${MATCH_BADGE[match.status]}`}>
                {MATCH_STATUS_LABELS[match.status]}
              </span>
              <span className="text-[10px] text-ink-300">
                {match.amap ? `高德：${match.amap.name}` : "高德：无对应 POI"}
              </span>
              {match.deviationMeters !== null && (
                <span className="font-mono text-[10px] text-ink-300">
                  偏差 {match.deviationMeters} 米
                </span>
              )}
            </div>
            {(match.reason || !match.routable) && (
              <p className="mt-0.5 text-[10px] leading-relaxed text-ink-500">
                {match.routable ? match.reason : (match.routableReason || match.reason)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function RejectionList({ report }: { report: VerifyReport }) {
  if (!report.rejections.length) return null;
  return (
    <details className="mt-2 rounded-lg bg-paper ring-1 ring-line">
      <summary className="cursor-pointer px-2.5 py-2 text-[11px] font-medium text-ink-700">
        为什么不是这些地点 · {report.rejections.length} 条排除原因
      </summary>
      <ul className="space-y-1 px-2.5 pb-2.5">
        {report.rejections.map((rejection, index) => (
          <li key={`${rejection.name}-${index}`} className="text-[10px] leading-relaxed text-ink-500">
            <span className="font-medium text-ink-700">{rejection.name}</span>
            <span className="text-ink-300"> — {rejection.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
