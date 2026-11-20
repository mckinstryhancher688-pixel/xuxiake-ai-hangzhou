"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiscoverPanel } from "@/components/DiscoverPanel";
import { ElderView } from "@/components/ElderView";
import { ExplorePanel } from "@/components/ExplorePanel";
import { ItineraryPanel } from "@/components/ItineraryPanel";
import { MapPanel } from "@/components/MapPanel";
import { NegotiationPanel } from "@/components/NegotiationPanel";
import { PlanActionBar } from "@/components/PlanActionBar";
import { SiteHeader } from "@/components/SiteHeader";
import { AuditDetails, VerifiedRoutePanel } from "@/components/VerifiedRoutePanel";
import { StaminaMeter } from "@/components/StaminaMeter";
import { WalkLimitPanel } from "@/components/WalkLimitPanel";
import type { VerifiedItinerary } from "@/lib/types";
import { useAgent } from "@/hooks/useAgent";
import { useDiscover } from "@/hooks/useDiscover";
import { useJourney } from "@/hooks/useJourney";
import { useMapJsConfig } from "@/hooks/useMapJsConfig";
import { usePlan } from "@/hooks/usePlan";
import { useRouteGeometry } from "@/hooks/useRouteGeometry";
import { useVerifiedRoute } from "@/hooks/useVerifiedRoute";
import { buildVerifiedScene } from "@/lib/map/verified-scene";
import type { MapFeature, MapRouteLine } from "@/components/map/types";
import { executableOfficial } from "@/lib/negotiation/official-view";
import { parseCategories } from "@/lib/discovery";
import { DEFAULT_STAY_MINUTES, minutesLabel } from "@/lib/walk-minutes";

type MobileTab = "map" | "plan";
/** 生成路线之后的右栏分页：一屏只回答一个问题 */
type PlanPage = "route" | "adjust" | "advanced";

export function JourneyApp() {
  const journey = useJourney();
  const [tab, setTab] = useState<MobileTab>("map");
  const [planPage, setPlanPage] = useState<PlanPage>("route");
  // 两个面板与调试面板共用同一份状态，所以在这里统一持有
  const discover = useDiscover(journey.context.city);
  const verifiedRoute = useVerifiedRoute(journey.context.city);
  const mapConfig = useMapJsConfig();
  // 双人协商挂在同一份已核验事实层上：不新建第二套数据，也不改单人链路
  const plan = usePlan();
  // 只有服务端判定「双方确认了同一个版本」时，这一版才成为正式执行路线。
  // 读的是服务端返回的 official 那一版，不退回更早的城市/类别结果，浏览器也不自行判定。
  const official = executableOfficial(plan.snapshot, plan.busy, plan.syncError);
  const jointRoute = official?.itinerary ?? null;
  const itineraryCategories = jointRoute ? parseCategories(plan.snapshot?.facts.categories) : verifiedRoute.usedCategories;
  const jointMode = plan.identity !== null || (plan.exited && plan.error !== null);
  const jointBlocked = jointMode && jointRoute === null;
  const jointBlockReason = plan.busy ? "正在保存协商结果，完成前暂停执行。"
    : plan.error ?? plan.snapshot?.canExecute.reason ?? "正在读取当前协商状态，请稍候。";
  const effectiveReport =
    jointBlocked ? null : jointRoute && verifiedRoute.report ? { ...verifiedRoute.report, itinerary: jointRoute } : verifiedRoute.report;
  // 只有双方确认的正式版本真的在屏幕上生效时，才把这条协商交给智能体：
  // 于是「我到了」读的就是地图与面板上那一份，不会再按 city/类别 回到旧的单人路线。
  const agentScope = useMemo(
    () => (jointRoute && plan.identity ? { planId: plan.identity.planId, token: plan.identity.token, itinerary: jointRoute } : null),
    [jointRoute, plan.identity],
  );
  const agent = useAgent(
    journey.context.city,
    journey.context.interests,
    effectiveReport,
    agentScope,
    jointBlocked,
  );
  // 双人协商挂在同一份已核验事实层上：不新建第二套数据，也不改单人链路
  // 地图跟着「当前生效行程」走：智能体调整过就用调整后的，否则用（可能已被双方确认版替换过的）核验结果；
  // 两者都还没有时只能继续显示演示行程，绝不把未核验的飞猪坐标画上去。
  // 亲情模式：用户在「爸妈全程一共能走多久」里重解出的行程优先于智能体结果，因为它是最新的显式选择。
  const [soloOverride, setSoloOverride] = useState<VerifiedItinerary | null>(null);
  // 出门前先问的那一句：爸妈全程一共能走多久（分钟）。定下来之后，核验一完成就用它重解一次，不用生成完再改。
  // 三种状态不能混：undefined = 还没回答；null = 用户答了「不确定」（不设上限）；数字 = 用户选的分钟数。
  const [preflightMinutes, setPreflightMinutes] = useState<number | null | undefined>(undefined);
  // 每站停留分钟（D2）：只在「调整」页改；换类别重新核验后也要按它重解
  const [stayMinutes, setStayMinutes] = useState<number>(DEFAULT_STAY_MINUTES);
  const [elderOpen, setElderOpen] = useState(false);
  const activeItinerary = soloOverride ?? agent.activeItinerary;
  /** 是否已经有真实路线：首屏只在「没有路线」时展示提问与生成按钮，生成后切成三个分页 */
  const hasRoute = (activeItinerary?.stops?.length ?? 0) > 0;

  /**
   * 出门前定的那条线，用在「核验刚成功」这一刻：拿事实层免费重解一次，
   * 用户就不用先生成一条不合用的路线再手动改。
   * 只在 factsId 变化时跑一次，避免每次渲染都发请求；失败就保留核验原结果。
   */
  const preflightFactsId = verifiedRoute.report?.ok ? verifiedRoute.report.facts?.factsId ?? null : null;
  const [preflightNote, setPreflightNote] = useState<string | null>(null);
  // 已经按「这份事实集 + 这个分钟数」重解成功过的记号：「调整」页的面板刚解完会回写 preflightMinutes，
  // 没有这个记号这里会再发一次一模一样的请求。
  const resolvedKeyRef = useRef<string | null>(null);
  /** 「一口气能走」的上限；null = 没设。评估器要靠它画第二条进度条，必须能触发重渲染。 */
  const [segmentLimitMeters, setSegmentLimitMeters] = useState<number | null>(null);
  useEffect(() => {
    // 没回答、或答了「不确定」时不重解：核验给出的就是不设上限的最优路线，没有什么可重排的
    if (!preflightFactsId || typeof preflightMinutes !== "number") return;
    const resolvedKey = `${preflightFactsId}|${preflightMinutes}|${stayMinutes}`;
    if (resolvedKeyRef.current === resolvedKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ factsId: preflightFactsId, maxWalkMinutes: preflightMinutes, stayMinutes }),
        });
        if (!response.ok) return;
        const body = await response.json();
        if (cancelled) return;
        if (body?.ok === true && body.itinerary) {
          resolvedKeyRef.current = resolvedKey;
          setSoloOverride(body.itinerary);
          setPreflightNote(null);
        } else {
          // 定得太紧时如实说清楚，不能静默退回一条超限的路线
          setPreflightNote(
            `按「${minutesLabel(preflightMinutes)}」排不出可行路线，下面显示的仍是原核验结果。` +
            (body?.reason ? `原因：${String(body.reason).slice(0, 90)}` : ""),
          );
        }
      } catch {
        // 重解失败不影响已核验的路线；用户仍可在面板里手动改
      }
    })();
    return () => { cancelled = true; };
  }, [preflightFactsId, preflightMinutes, stayMinutes]);
  // 调整过之后，核验面板显示的就是这一份；原始核验结果只在开发调试面板里保留。
  const routeAdjusted = activeItinerary !== null && activeItinerary !== (verifiedRoute.report?.itinerary ?? null);
  const scene: "verified" | "demo" = activeItinerary ? "verified" : "demo";
  const geometry = useRouteGeometry(activeItinerary, jointRoute && plan.identity && official
    ? { planId: plan.identity.planId, token: plan.identity.token, officialRevision: official.revision }
    : null, jointMode);
  const verifiedScene = useMemo(
    () =>
      activeItinerary
        ? buildVerifiedScene(
            activeItinerary,
            agent.arrivedStopIds,
            agent.selectedStopId,
            geometry.byLeg,
          )
        : null,
    [activeItinerary, agent.arrivedStopIds, agent.selectedStopId, geometry.byLeg],
  );

  const mapFeatures: MapFeature[] = verifiedScene?.features ?? journey.mapFeatures;
  const mapRouteLines: MapRouteLine[] = verifiedScene?.routeLines ?? journey.mapRouteLines;
  const activeFeatureId =
    scene === "verified" ? agent.selectedStopId : journey.activePoi.id;

  const { selectPoi } = journey;
  const { selectStop } = agent;
  const selectFeature = useCallback(
    (id: string) => {
      // 两条链路都只是改前端选中状态：不会、也不允许触发百炼或高德调用
      if (scene === "verified") selectStop(id);
      else selectPoi(id);
    },
    [scene, selectPoi, selectStop],
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader
        context={journey.context}
        plan={
          activeItinerary
            ? {
                stops: activeItinerary.stops.length,
                totalMinutes: activeItinerary.totalMinutes,
                budgetMinutes: activeItinerary.budgetMinutes,
              }
            : null
        }
      />

      {/* 没有真实路线时右栏居中、地图整块不出现：首页只回答一个问题 */}
      <main className={`mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 px-4 pt-4 pb-40 sm:px-6 lg:items-start lg:pb-4 ${
        hasRoute ? "lg:grid lg:grid-cols-[minmax(0,1fr)_25rem]" : "lg:grid lg:grid-cols-[minmax(0,44rem)] lg:justify-center"
      }`}>
        {hasRoute && (
          <div
            // min-w-0 + overflow-hidden：grid 子项默认 min-width:auto，
            // 地图里的 SVG 是 replaced 元素，会把整列撑宽并压到右栏上。
            className={`min-w-0 overflow-hidden ${tab === "map" ? "block" : "hidden"} lg:sticky lg:top-4 lg:block lg:h-[calc(100dvh-7.5rem)]`}
          >
            {jointBlocked ? (
              <div className="flex min-h-[24rem] h-full items-center justify-center rounded-2xl border border-line bg-card p-6">
                <div className="max-w-md text-sm leading-6">
                  <h2 className="font-semibold">路线暂停执行，等待双方确认</h2>
                  <p className="mt-2 text-ink-500">{jointBlockReason}</p>
                  <p className="mt-2 text-ink-500">确认前不显示旧路线，也不会切回单人行程。</p>
                  <a href="#joint-negotiation" onClick={() => setTab("plan")} className="mt-3 inline-block text-brand-700 underline">查看协商与确认</a>
                </div>
              </div>
            ) : <MapPanel
              features={mapFeatures}
              routeLines={mapRouteLines}
              lakeOutline={journey.geography.lakeOutline}
              streets={journey.geography.streets}
              activeFeatureId={activeFeatureId}
              onSelectFeature={selectFeature}
              scene={scene}
              mapConfig={mapConfig}
              undrawnLegs={verifiedScene?.undrawnLegs ?? []}
            />}
          </div>
        )}

        <div className="flex min-h-0 flex-col gap-4">
          {/* 手机端分页：没有路线时不显示「地图」，先把注意力留在生成上 */}
          {hasRoute && (
            <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-card p-1 lg:hidden">
              <TabButton active={tab === "map"} onClick={() => setTab("map")}>
                地图
              </TabButton>
              <TabButton active={tab === "plan"} onClick={() => setTab("plan")}>
                行程与探索
              </TabButton>
            </div>
          )}

          {/* 还没有路线时，先给一句「这是干什么的」，再给唯一的那一问 */}
          {!hasRoute && !jointBlocked && (
            <div className="rounded-3xl border border-line bg-card px-5 py-6 text-center shadow-card">
              <span className="inline-flex items-center gap-2 rounded-full border border-line bg-paper px-3.5 py-1 text-[11px] text-ink-500">
                <span className="size-1.5 rounded-full bg-zero-600" aria-hidden />
                {journey.context.city}半日慢游 · 飞猪实景图文 × 高德实测步行路网
              </span>
              <h2 className="mt-3 font-display text-2xl leading-snug font-bold text-brand-700 sm:text-3xl">
                陪爸妈慢逛{journey.context.district}，
                <br className="sm:hidden" />
                一段一段都实测过
              </h2>
              <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-ink-500">
                飞猪出地点与实景图，高德逐段实测步行距离与耗时。先在下面回答一个问题：爸妈全程一共能走多久。
              </p>
            </div>
          )}

          {/* 主流程按钮：窄屏钉在屏幕下沿（滚到哪一步都能点，首屏就一定看得见），
              桌面端回到右栏顶部跟随滚动。同一份组件、同一批按钮，不会出现两个入口。 */}
          <div className="fixed inset-x-0 bottom-0 z-30 p-3 lg:sticky lg:inset-x-auto lg:bottom-auto lg:top-4 lg:z-20 lg:p-0">
            {jointBlocked ? (
              <div className="rounded-2xl border border-line bg-card/95 p-3 text-xs shadow-sm">
                <p className="font-medium">双人方案尚未生效</p>
                <p className="mt-1 text-ink-500">{jointBlockReason}</p>
                <a href="#joint-negotiation" onClick={() => setTab("plan")} className="mt-2 inline-block text-brand-700 underline">查看双方条件并确认</a>
              </div>
            ) : <PlanActionBar route={verifiedRoute} agent={agent} categories={discover.selected} itineraryCategories={itineraryCategories} jointLocked={jointRoute !== null} preflightMinutes={preflightMinutes} onPreflightChange={setPreflightMinutes} />}
          </div>

          {/* 右栏最顶部：分页 + 大字版入口。右栏只有 25rem，横排放不下，改成两行。 */}
          {!jointBlocked && (
            <div className="flex flex-col gap-2">
              <div
                className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-card p-1"
                role="tablist"
                aria-label="行程分页"
              >
                {([
                  ["route", "行程"],
                  ["adjust", "调整"],
                  ["advanced", "核验明细"],
                ] as [PlanPage, string][])
                  .filter(([key]) => hasRoute || key !== "adjust")
                  .map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={planPage === key}
                      onClick={() => setPlanPage(key)}
                      className={`rounded-lg px-2 py-2 text-xs font-medium transition ${
                        planPage === key ? "bg-brand-700 text-white" : "text-ink-500 hover:bg-paper"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
              </div>
              {hasRoute && (
                <button
                  type="button"
                  onClick={() => setElderOpen(true)}
                  className="flex w-full items-center justify-between rounded-xl border-2 border-brand-600/40 bg-brand-50/60 px-3 py-2 text-xs font-semibold text-brand-700 transition hover:border-brand-600"
                >
                  <span>给爸妈看 · 大字版</span>
                  <span aria-hidden>›</span>
                </button>
              )}
            </div>
          )}

          <div
            className={`${!hasRoute || tab === "plan" ? "flex" : "hidden"} flex-col gap-4 lg:flex lg:overflow-y-auto lg:pr-1`}
          >
            {/* ── 还没有路线：行程页只留一句下一步，提问与生成都在上面的主流程条里 ── */}
            {!hasRoute ? (
              <p className="rounded-2xl border border-line bg-card px-4 py-3 text-[11px] leading-relaxed text-ink-500">
                回答上面那一句、点「生成我的路线」即可。要换「文创街区」以外的类别，生成后到「核验明细」里换。
              </p>
            ) : null}

            {/* ── 行程页：看路线 ───────────────────────────────── */}
            {hasRoute && planPage === "route" && !jointBlocked && (
              <>
                <VerifiedRoutePanel
                  route={verifiedRoute}
                  categories={discover.selected}
                  activeItinerary={activeItinerary}
                  routeAdjusted={jointRoute ? false : routeAdjusted}
                  jointRevision={jointRoute ? (plan.snapshot?.officialRevision ?? null) : null}
                  onSelectCategories={discover.selectCategories}
                  selectedStopId={agent.selectedStopId}
                  arrivedStopIds={agent.arrivedStopIds}
                  onSelectStop={agent.selectStop}
                  agent={agent}
                />
              </>
            )}

            {/* ── 调整页：改走多久 ─────────────────────────────── */}
            {hasRoute && planPage === "adjust" && !jointBlocked && (
              <>
                {preflightNote && (
                  <p className="rounded-xl bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-ink-700 ring-1 ring-amber-500/25">
                    {preflightNote}
                  </p>
                )}
                {/* 体力评估器：两条约束的「预算 vs 已用」进度条，先给结论再给调节项 */}
                <StaminaMeter
                  usedMinutes={activeItinerary?.totalWalkMinutes ?? null}
                  minuteLimit={preflightMinutes ?? null}
                  usedSegmentMeters={
                    activeItinerary?.legs?.length
                      ? Math.max(...activeItinerary.legs.map((leg) => leg.distanceMeters))
                      : null
                  }
                  segmentLimitMeters={segmentLimitMeters}
                />
                {verifiedRoute.report?.ok && verifiedRoute.report.facts?.factsId ? (
                  <WalkLimitPanel
                    factsId={verifiedRoute.report.facts.factsId}
                    showSegmentLimit
                    currentLongestSegmentMeters={
                      activeItinerary?.legs?.length
                        ? Math.max(...activeItinerary.legs.map((leg) => leg.distanceMeters))
                        : null
                    }
                    currentWalkMeters={activeItinerary?.totalWalkMeters ?? null}
                    currentWalkMinutes={activeItinerary?.totalWalkMinutes ?? null}
                    selectedMinutes={preflightMinutes}
                    selectedStay={stayMinutes}
                    onResolved={(itinerary, applied) => {
                      setSoloOverride(itinerary);
                      setPreflightNote(null);
                      resolvedKeyRef.current = `${preflightFactsId}|${applied.maxWalkMinutes}|${applied.stayMinutes}`;
                      setPreflightMinutes(applied.maxWalkMinutes);
                      setStayMinutes(applied.stayMinutes);
                      // 评估器的第二条进度条要靠这个上限；null 会显示成「未设上限」
                      setSegmentLimitMeters(applied.maxSegmentMeters);
                    }}
                  />
                ) : (
                  <p className="rounded-xl bg-paper px-3 py-2 text-[11px] text-ink-500">这份报告没有可复用的事实集，需要重新生成一次才能调整。</p>
                )}
              </>
            )}

            {/* ── 核验明细页：原始记录、候选统计、坐标系、排除原因、口径 ── */}
            {hasRoute && planPage === "advanced" && !jointBlocked && (
              <>
                <AuditDetails report={verifiedRoute.report} />
                <div className="rounded-2xl border border-line bg-card p-3">
                  <p className="text-xs font-semibold text-ink-700">换个类别重跑</p>
                  <p className="mt-1 text-[10.5px] leading-relaxed text-ink-500">
                    重新核验会真实消耗高德调用（约 36 次）。当前类别：{itineraryCategories.join(" + ")}。
                  </p>
                  <button
                    type="button"
                    onClick={() => void verifiedRoute.verify(discover.selected)}
                    disabled={verifiedRoute.phase === "loading"}
                    className="mt-2 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[11px] font-medium text-brand-700 disabled:opacity-50"
                  >
                    {verifiedRoute.phase === "loading" ? "核验中…" : "按当前类别重新核验"}
                  </button>
                </div>
                <DiscoverPanel cityName={journey.context.city} discover={discover} />
                <div id="joint-negotiation">
                  <NegotiationPanel plan={plan} factsId={verifiedRoute.report?.facts?.factsId ?? null} />
                </div>
              </>
            )}

            {/* 演示链路（预写行程与讲解）只是样例参考，不该占首屏：
                只在「更多」页里出现，且一旦有真实路线就完全不显示。 */}
            {!activeItinerary && !jointMode && !verifiedRoute.report && hasRoute === false && planPage === "advanced" && (
              <>
                <p className="rounded-xl bg-paper px-3 py-2 text-[10.5px] leading-relaxed text-ink-500 ring-1 ring-line">
                  下面是**演示样例**（不是这次的真实结果），用来看界面大致长什么样。
                </p>
                <ItineraryPanel
                  routeLabel={journey.route.label}
                  routeSummary={journey.route.summary}
                  totalWalkMeters={journey.route.totalWalkMeters}
                  totalMinutes={journey.route.totalMinutes}
                  pois={journey.pois}
                  activePoi={journey.activePoi}
                  visitedIds={journey.visitedIds}
                  legFrom={journey.legFrom}
                  routeId={journey.route.id}
                  isActiveVisited={journey.isActiveVisited}
                  explorationStatus={journey.explorationStatus}
                  onSelect={journey.selectPoi}
                  onArrive={journey.markArrived}
                  onToggleRoute={journey.toggleRoute}
                />
                <ExplorePanel
                  poi={journey.activePoi}
                  exploration={journey.exploration}
                  explorationStatus={journey.explorationStatus}
                />
              </>
            )}
          </div>

        </div>
      </main>

      {/* 大字版：全屏覆盖，只讲去哪、走多久、厕所在哪 */}
      <ElderView
        open={elderOpen}
        onClose={() => setElderOpen(false)}
        itinerary={activeItinerary}
        toilets={verifiedRoute.report?.toilets}
        limitMinutes={preflightMinutes ?? null}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
        active ? "bg-brand-700 text-white" : "text-ink-500 hover:bg-paper"
      }`}
    >
      {children}
    </button>
  );
}
