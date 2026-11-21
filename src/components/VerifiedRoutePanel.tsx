import { formatDistance, formatMinutes } from "@/lib/format";
import { formatHangzhouDateTime } from "@/lib/hangzhou-time";
import { AgentPanel } from "@/components/AgentPanel";
import { StopPhoto } from "@/components/StopPhoto";
import { StopToiletLine, ToiletScopeNote } from "@/components/ToiletNote";
import { sameCategories, type FlyAiPoiCategory } from "@/lib/discovery";
import type { VerifiedRoute, VerifyPhase } from "@/hooks/useVerifiedRoute";
import type { AgentController } from "@/hooks/useAgent";
import { MATCH_STATUS_LABELS, OPENING_STATUS_LABELS } from "@/lib/verification";
import { billOf, stayText } from "@/lib/walk-minutes";
import type {
  CandidateMatch,
  DatumConclusion,
  MatchStatus,
  RouteStart,
  ToiletLookup,
  VerifiedItinerary,
  VerifyReport,
} from "@/lib/types";

const PHASE_BADGE: Record<VerifyPhase, { label: string; className: string }> = {
  idle: { label: "未核验", className: "bg-paper text-ink-300 ring-1 ring-line" },
  loading: { label: "核验中…", className: "bg-accent-500/15 text-accent-600" },
  done: { label: "已核验", className: "bg-brand-600/15 text-brand-700" },
  failed: { label: "核验失败", className: "bg-red-500/10 text-red-600" },
};

const MATCH_BADGE: Record<MatchStatus, string> = {
  matched: "bg-brand-600/15 text-brand-700",
  suspicious: "bg-accent-500/15 text-accent-600",
  unverified: "bg-ink-300/25 text-ink-500",
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
  route,
  categories,
  activeItinerary,
  routeAdjusted,
  jointRevision = null,
  onSelectCategories,
  selectedStopId,
  arrivedStopIds,
  onSelectStop,
  agent,
}: {
  route: VerifiedRoute;
  /** 界面上勾中的飞猪类别：候选池就是它，跟「重新发现」面板共用同一份勾选 */
  categories: FlyAiPoiCategory[];
  activeItinerary: VerifiedItinerary | null;
  routeAdjusted: boolean;
  /** 双方确认的正式版本号；非空时屏幕上这一份就是它，不再是单人调整结果 */
  jointRevision?: number | null;
  onSelectCategories: (categories: FlyAiPoiCategory[]) => void;
  selectedStopId: string | null;
  arrivedStopIds: string[];
  onSelectStop: (id: string) => void;
  agent: AgentController;
}) {
  const loading = route.phase === "loading";
  const report = route.report;
  // 主界面只有一份「当前生效路线」：智能体调整过就显示调整后的，与左侧地图完全一致。
  const shownItinerary = activeItinerary ?? report?.itinerary ?? null;
  const official = jointRevision !== null && shownItinerary !== null;
  const stale = report !== null && !sameCategories(report.categories, categories);
  const badge = official
    ? { label: `双方确认 · v${jointRevision}`, className: "bg-brand-600/15 text-brand-700" }
    : loading ? PHASE_BADGE.loading
    : stale ? { label: "待按新类别核验", className: "bg-accent-500/15 text-accent-600" }
    : report && !report.ok ? { label: "未找到可行路线", className: "bg-accent-500/15 text-accent-600" }
    : PHASE_BADGE[route.phase];

  return (
    <section className="rounded-2xl border border-line bg-card p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-sm font-bold text-brand-700">这条路线怎么走</h2>
        <span className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-medium ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      {/* 类别切换、重新核验、恢复说明都属于「核验明细」，行程页只留一句状态 */}
      {!official && stale && (
        <p className="mt-2 rounded-lg bg-accent-50 p-2 text-[11px] leading-relaxed text-accent-700">
          已改选「{categories.join(" + ")}」，下方仍是「{report.categories.join(" + ")}」的核验结果。
        </p>
      )}
      {!official && loading && <p className="mt-2 text-[11px] text-ink-500">正在核验新类别，下方仍是旧结果。</p>}

      {!official && route.error && (
        <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
          <p className="text-[11px] font-semibold text-red-600">
            「{route.requestedCategories.join(" + ")}」核验失败 · 已有记录继续保留
          </p>
          <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-ink-700">
            {route.error}
          </p>
        </div>
      )}

      {!shownItinerary && route.phase === "idle" && (
        <p className="mt-3 rounded-lg bg-paper px-2.5 py-2 text-[11px] leading-relaxed text-ink-300 ring-1 ring-line">
          还没有发起核验。地图与行程仍是<strong className="font-semibold text-accent-600">演示数据（Mock）</strong>，
          未经高德验证；点「开始核验」后这里会给出真实路线。
        </p>
      )}

      {shownItinerary && (
        <>
          {official ? (
            <p className="mt-3 rounded-lg bg-emerald-50 px-2.5 py-2 text-[11px] leading-relaxed text-emerald-800 ring-1 ring-emerald-200">
              这里列出<strong className="font-semibold">双方确认的正式路线 v{jointRevision}</strong>，地图与时间合计都以它为准。
              调整请在「双人协商」中提出，并等待双方确认新版本。
            </p>
          ) : routeAdjusted ? (
            <p className="mt-3 rounded-lg bg-accent-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-accent-700">
              以下是按你定的条件（全程能走多久、每站停留多久）重新排的当前生效路线，与地图一致；原始核验记录保留在「核验明细」页。
            </p>
          ) : null}
          <Itinerary itinerary={shownItinerary} selectedStopId={selectedStopId} arrivedStopIds={arrivedStopIds} onSelectStop={onSelectStop} agent={agent} toilets={report?.toilets} />
        </>
      )}

      {!official && report && !report.itinerary && !sameCategories(categories, ["文创街区"]) && (
        <div className="mt-3 rounded-lg bg-paper p-3 text-[11px] leading-relaxed ring-1 ring-line">
          <p>可改选文创街区再尝试。市内街区通常更集中，但仍须真实核验，不能保证一定有解。</p>
          <button type="button" disabled={loading} onClick={() => onSelectCategories(["文创街区"])} className="mt-2 rounded-lg border border-line bg-card px-2.5 py-1.5 font-medium text-brand-700 disabled:opacity-50">
            改选文创街区（仅切换类别）
          </button>
          <p className="mt-1 text-ink-500">只修改勾选；确认类别后再手动生成，不会自动发起请求。</p>
        </div>
      )}

      {/* 错误与不可行说明属于「结果」，留在行程页；原始记录等审计信息移到「核验明细」页 */}
      {report?.error && (
        <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
          <p className="text-[11px] font-semibold text-red-600">核验没有跑完</p>
          <p className="mt-1 break-words text-[11px] leading-relaxed text-ink-700">{report.error}</p>
        </div>
      )}

      {report?.insufficiency && (
        <div className="mt-3 rounded-xl border border-accent-500/40 bg-accent-50 p-3">
          <p className="text-[11px] font-semibold text-accent-600">未生成可行路线</p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-700">{report.insufficiency}</p>
        </div>
      )}
    </section>
  );
}

/**
 * 「核验明细」页：原始记录、候选统计、坐标系判定、排除原因、洗手间口径。
 * 从行程卡里整体搬过来，行程页因此只剩站名与距离。
 */
export function AuditDetails({ report }: { report: VerifyReport | null }) {
  if (!report) {
    return <p className="rounded-xl bg-paper px-3 py-2 text-[11px] text-ink-500">还没有核验记录。</p>;
  }
  return (
    <section className="rounded-2xl border border-line bg-card p-4">
      <p className="text-[11px] font-medium text-ink-500">
        原始核验记录 · {report.categories.join(" + ")} · {formatHangzhouDateTime(report.generatedAt)}
      </p>
      <p className="mt-1 text-[10px] leading-relaxed text-ink-300">
        核验会产生数十次真实请求；成功结果整体缓存约 30 分钟，失败重试、补测或缓存过期可能新增调用。
      </p>
      {report.amap && (
        <p className="mt-1 text-[10px] text-ink-500">
          本次记录：地点请求 {report.amap.placeCalls} 次 · 步行请求 {report.amap.walkingCalls} 次 · 缓存命中{" "}
          {report.amap.cacheHits} 次 · 失败 {report.amap.failedCalls} 次。
        </p>
      )}
      <CountLine report={report} />
      <ToiletScopeNote lookup={report.toilets} />

      {report.start && <StartLine start={report.start} />}

      <details className="mt-3 rounded-lg bg-paper ring-1 ring-line">
        <summary className="cursor-pointer px-2.5 py-2 text-[11px] font-medium text-ink-700">
          核验依据 · 坐标系判定与飞猪原始坐标的处理方式
        </summary>
        <DatumLine datum={report.datum} />
      </details>
      <CandidateTable matches={report.matches} />
      <RejectionList report={report} />
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
  agent,
  toilets,
}: {
  itinerary: VerifiedItinerary;
  selectedStopId: string | null;
  arrivedStopIds: string[];
  onSelectStop: (id: string) => void;
  /** 「我到了」内嵌在每一站，需要能触发讲解 */
  agent: AgentController;
  toilets?: ToiletLookup | null;
}) {
  const arrived = new Set(arrivedStopIds);
  return (
    <div className="mt-3 rounded-2xl border border-line bg-paper/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-sm font-bold text-brand-700">
          已排好 {itinerary.stops.length} 站 · 四小时内走得完
        </h3>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold ${
            itinerary.feasible
              ? "border-zero-600/25 bg-zero-50 text-zero-600"
              : "border-warn-600/25 bg-warn-50 text-warn-600"
          }`}
        >
          {itinerary.feasible ? "四小时内可完成" : "超出四小时"}
        </span>
      </div>

      <dl className="mt-2 flex flex-wrap gap-1.5">
        <Chip label="合计" value={`${itinerary.totalMinutes} / ${itinerary.budgetMinutes} 分钟`} tone="brand" />
        <Chip label="步行" value={`${itinerary.totalWalkMinutes} 分钟 · ${formatDistance(itinerary.totalWalkMeters)}`} />
        <Chip label="停留" value={stayText(billOf(itinerary))} />
        <Chip label="缓冲" value={`${itinerary.bufferMinutes} 分钟`} />
      </dl>

      <p className="mt-2 text-[10px] leading-relaxed text-ink-500">
        按 {formatHangzhouDateTime(itinerary.assumedStartAt)} 出发估算；步行数值来自高德路径规划。
      </p>

      <ol className="mt-3">
        <li className="flex items-start gap-2.5 rounded-2xl border border-line bg-card px-3.5 py-2.5 shadow-card">
          <span className="grid size-5 shrink-0 place-items-center rounded-md bg-brand-700 font-display text-[11px] font-bold text-white">
            起
          </span>
          <span className="min-w-0 text-[12px] font-medium text-ink-900">
            <span className="font-display font-bold">{itinerary.start.name}</span>
            <span className="ml-1.5">
              <SourceTag kind="amap" />
            </span>
            <span className="mt-0.5 block text-[10px] font-normal text-ink-400">
              {itinerary.start.address ?? "高德未返回地址"}
            </span>
          </span>
        </li>

        {itinerary.stops.map((stop, index) => {
          const leg = itinerary.legs[index];
          const isActive = stop.flyaiId === selectedStopId;
          const isArrived = arrived.has(stop.flyaiId);
          /** 只有这一站自己生成过讲解，按钮才说「再看一次」，卡片里才会挂讲解 */
          const hasNarration = agent.arrival?.stopName === stop.name;
          const isFree = stop.flyaiFreeStatus === "FREE";
          return (
            <li key={stop.amapId || stop.flyaiId}>
              {leg && (
                <div className="relative py-2.5 pl-10">
                  {/* 虚线时间轴：与卡片里的序号方块同一条竖线（左 24px） */}
                  <span
                    className="absolute top-0 bottom-0 left-6 border-l-2 border-dashed border-brand-700/25"
                    aria-hidden
                    data-testid="leg-line"
                  />
                  <p
                    className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1 text-[11px] text-ink-700 shadow-sm"
                    data-testid="leg-chip"
                  >
                    <span aria-hidden>🚶</span>
                    <span>
                      高德实测步行{" "}
                      <strong className="font-semibold text-brand-700 tabular-nums">
                        {formatDistance(leg.distanceMeters)}
                      </strong>{" "}
                      · 约 {leg.durationMinutes} 分钟
                    </span>
                  </p>
                </div>
              )}

              <article
                className={`rounded-2xl border bg-card p-3.5 transition shadow-card ${
                  isActive
                    ? "border-brand-700 ring-1 ring-brand-700/20"
                    : "border-line hover:border-brand-700/40"
                }`}
              >
                <div className="flex items-start gap-3.5">
                  <span data-testid="stop-photo">
                    <StopPhoto src={stop.flyaiMainPic} name={stop.name} />
                  </span>

                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span
                          className={`grid size-5 shrink-0 place-items-center rounded-md font-display text-[11px] font-bold text-white tabular-nums ${
                            isArrived ? "bg-zero-600" : "bg-brand-700"
                          }`}
                        >
                          {isArrived ? "✓" : index + 1}
                        </span>
                        <h4 className="truncate font-display text-sm font-bold text-ink-900">{stop.name}</h4>
                        {isFree && (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-zero-600/20 bg-zero-50 px-2 py-px text-[10px] font-semibold text-zero-600"
                            data-testid="free-badge"
                            title="飞猪标注的免费开放状态；门票与当天是否开放以现场为准"
                          >
                            免费
                            <SourceTag kind="flyai" />
                          </span>
                        )}
                      </div>
                      {stop.jumpUrl && (
                        <a
                          href={stop.jumpUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-line bg-paper px-2 py-0.5 text-[11px] font-semibold text-accent-600 transition hover:bg-accent-soft/60"
                        >
                          飞猪详情
                          <span aria-hidden>↗</span>
                        </a>
                      )}
                    </div>

                    <p className="truncate text-[11px] leading-relaxed text-ink-500">
                      {stop.address ?? "地址未返回"}
                    </p>

                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
                      <span className="inline-flex items-center gap-1 font-medium text-zero-600">
                        <span className="size-1.5 rounded-full bg-zero-600" aria-hidden />
                        {OPENING_STATUS_LABELS[stop.openingStatus]}
                      </span>
                      <span className="text-ink-500">
                        停留 {stop.stayMinutes} 分钟
                      </span>
                    </div>

                    <StopToiletLine lookup={toilets} stopName={stop.name} />
                  </div>
                </div>

                {/* 「我到了」内嵌在当前站：选中这一站，并把这一站的 id 直接交给请求 */}
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
                  <button
                    type="button"
                    disabled={agent.arrived.phase === "loading"}
                    onClick={() => {
                      onSelectStop(stop.flyaiId);
                      agent.arrive(stop.flyaiId);
                    }}
                    className="rounded-xl bg-brand-700 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-brand-800 disabled:opacity-50"
                  >
                    {agent.arrived.phase === "loading" && agent.arrived.stopId === stop.flyaiId
                      ? "讲解生成中…"
                      : hasNarration
                        ? "我到了（再看一次）"
                        : "我到了"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectStop(stop.flyaiId)}
                    aria-pressed={isActive}
                    className={`rounded-xl px-2.5 py-1.5 text-[11px] ring-1 transition ${
                      isActive
                        ? "bg-accent-soft text-accent-600 ring-accent-600/30"
                        : "bg-paper text-ink-500 ring-line hover:bg-card"
                    }`}
                  >
                    {isActive ? "地图已定位" : "在地图定位"}
                  </button>
                </div>

                {/* 讲解只在这一站被选中、且这段讲解确实是它自己的时候才渲染，避免串站 */}
                {isActive && (
                  <AgentPanel
                    agent={agent}
                    stops={itinerary.stops.map((item) => ({
                      flyaiId: item.flyaiId,
                      name: item.name,
                      matchStatus: item.matchStatus,
                    }))}
                    embedded
                    forStopId={stop.flyaiId}
                    forStopName={stop.name}
                  />
                )}
              </article>
            </li>
          );
        })}
      </ol>

      <p className="mt-2 text-[10px] leading-relaxed text-ink-500">
        合计 {formatMinutes(itinerary.totalMinutes)}：步行 {itinerary.totalWalkMinutes} 分钟（
        <SourceTag kind="amap" /> 高德实测）＋ 停留 {stayText(billOf(itinerary))}（
        <SourceTag kind="simulated" /> 模拟，可在「调整」页改）＋ 缓冲{" "}
        {itinerary.bufferMinutes} 分钟（固定），预算 {itinerary.budgetMinutes} 分钟。
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
