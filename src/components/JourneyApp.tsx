"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentPanel } from "@/components/AgentPanel";
import { DataSourcePanel } from "@/components/DataSourcePanel";
import { DataTrustNote } from "@/components/DataTrustNote";
import { DebugPanel } from "@/components/DebugPanel";
import { DiscoverPanel } from "@/components/DiscoverPanel";
import { ElderView } from "@/components/ElderView";
import { ExplorePanel } from "@/components/ExplorePanel";
import { ItineraryPanel } from "@/components/ItineraryPanel";
import { MapPanel } from "@/components/MapPanel";
import { NegotiationPanel } from "@/components/NegotiationPanel";
import { PlanActionBar } from "@/components/PlanActionBar";
import { SiteHeader } from "@/components/SiteHeader";
import { VerifiedRoutePanel } from "@/components/VerifiedRoutePanel";
import { WalkLimitPanel } from "@/components/WalkLimitPanel";
import type { VerifiedItinerary } from "@/lib/types";
import { useAgent } from "@/hooks/useAgent";
import { agentDataSourceNote } from "@/lib/agent";
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

type MobileTab = "map" | "plan";
/** 生成路线之后的右栏分页：一屏只回答一个问题 */
type PlanPage = "route" | "adjust" | "advanced";

/** 已核验行程的免责说明与演示数据必须分开写，否则用户分不清哪条线是真的。 */
const VERIFIED_DISCLAIMER =
  "真实核验数据 · 点位坐标与步行折线均来自高德实测（折线沿真实道路，不是两点直线）；停留时长为模拟值，到达由你手动确认（不是真实 GPS）。";

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
  const verifiedStops = (agent.activeItinerary?.stops ?? []).map((stop) => ({
    flyaiId: stop.flyaiId,
    name: stop.name,
    matchStatus: stop.matchStatus,
  }));
  // 双人协商挂在同一份已核验事实层上：不新建第二套数据，也不改单人链路
  // 地图跟着「当前生效行程」走：智能体调整过就用调整后的，否则用（可能已被双方确认版替换过的）核验结果；
  // 两者都还没有时只能继续显示演示行程，绝不把未核验的飞猪坐标画上去。
  // 亲情模式：用户在「爸妈能走多远」里重解出的行程优先于智能体结果，因为它是最新的显式选择。
  const [soloOverride, setSoloOverride] = useState<VerifiedItinerary | null>(null);
  // 出门前先问的那一句。定下来之后，核验一完成就用它重解一次，不用生成完再改。
  const [preflightCap, setPreflightCap] = useState<number | null>(null);
  const [preflightSegmentCap, setPreflightSegmentCap] = useState<number | null>(null);
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
  useEffect(() => {
    if (!preflightFactsId || preflightCap === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ factsId: preflightFactsId, maxWalkMeters: preflightCap }),
        });
        if (!response.ok) return;
        const body = await response.json();
        if (cancelled) return;
        if (body?.ok === true && body.itinerary) {
          setSoloOverride(body.itinerary);
          setPreflightNote(null);
        } else {
          // 定得太紧时如实说清楚，不能静默退回一条超限的路线
          setPreflightNote(
            `按「${preflightCap} 米」排不出可行路线，下面显示的仍是原核验结果。` +
            (body?.reason ? `原因：${String(body.reason).slice(0, 90)}` : ""),
          );
        }
      } catch {
        // 重解失败不影响已核验的路线；用户仍可在面板里手动改
      }
    })();
    return () => { cancelled = true; };
  }, [preflightFactsId, preflightCap]);
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
        remainingMinutes={journey.remainingMinutes}
        routeLabel={journey.route.label}
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
            className={`${tab === "map" ? "block" : "hidden"} lg:sticky lg:top-4 lg:block lg:h-[calc(100dvh-7.5rem)]`}
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
              disclaimer={scene === "verified" ? VERIFIED_DISCLAIMER : journey.disclaimer}
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

          {/* 主流程按钮：窄屏钉在屏幕下沿（滚到哪一步都能点，首屏就一定看得见），
              桌面端回到右栏顶部跟随滚动。同一份组件、同一批按钮，不会出现两个入口。 */}
          <div className="fixed inset-x-0 bottom-0 z-30 p-3 lg:sticky lg:inset-x-auto lg:bottom-auto lg:top-4 lg:z-20 lg:p-0">
            {jointBlocked ? (
              <div className="rounded-2xl border border-line bg-card/95 p-3 text-xs shadow-sm">
                <p className="font-medium">双人方案尚未生效</p>
                <p className="mt-1 text-ink-500">{jointBlockReason}</p>
                <a href="#joint-negotiation" onClick={() => setTab("plan")} className="mt-2 inline-block text-brand-700 underline">查看双方条件并确认</a>
              </div>
            ) : <PlanActionBar route={verifiedRoute} agent={agent} categories={discover.selected} itineraryCategories={itineraryCategories} jointLocked={jointRoute !== null} preflightCap={preflightCap} onPreflightChange={setPreflightCap} />}
          </div>

          {/* 数据可信说明：只在有路线、且停在「行程」页时展示。
              首屏还没有任何数据可看，先不占用视觉重心。 */}
          {hasRoute && planPage === "route" && <DataTrustNote />}

          {/* 分页：一屏只回答一个问题。没路线时只有「行程」与「更多」（更多里有演示样例）。 */}
          {!jointBlocked && (
            <div className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-card p-1" role="tablist" aria-label="行程分页">
              {([
                ["route", "行程"],
                ["adjust", "调整"],
                ["advanced", "更多"],
              ] as [PlanPage, string][])
                .filter(([key]) => hasRoute || key !== "adjust")
                .map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={planPage === key}
                    onClick={() => setPlanPage(key)}
                    className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
                      planPage === key ? "bg-brand-700 text-white" : "text-ink-500 hover:bg-paper"
                    }`}
                  >
                    {label}
                  </button>
                ))}
            </div>
          )}

          <div
            className={`${!hasRoute || tab === "plan" ? "flex" : "hidden"} flex-col gap-4 lg:flex lg:overflow-y-auto lg:pr-1`}
          >
            {/* ── 还没有路线：只留「生成」这一件事（提问区已在底栏，这里只放一句说明） ── */}
            {!hasRoute ? (
              <p className="rounded-2xl border border-line bg-card px-4 py-3 text-[11px] leading-relaxed text-ink-500">
                选好上面的距离，点「生成我的路线」。要用「文创街区」以外的类别，生成后到「更多」里换。
              </p>
            ) : null}

            {/* ── 行程页：看路线 ───────────────────────────────── */}
            {hasRoute && planPage === "route" && !jointBlocked && (
              <>
                <VerifiedRoutePanel
                  cityName={journey.context.city}
                  route={verifiedRoute}
                  categories={discover.selected}
                  activeItinerary={activeItinerary}
                  routeAdjusted={jointRoute ? false : routeAdjusted}
                  jointRevision={jointRoute ? (plan.snapshot?.officialRevision ?? null) : null}
                  itineraryCategories={itineraryCategories}
                  onSelectCategories={discover.selectCategories}
                  selectedStopId={agent.selectedStopId}
                  arrivedStopIds={agent.arrivedStopIds}
                  onSelectStop={agent.selectStop}
                  showReverify={false}
                />
                <button
                  type="button"
                  onClick={() => setElderOpen(true)}
                  className="flex w-full items-center justify-between rounded-2xl border-2 border-brand-600/30 bg-brand-50/40 px-4 py-3 text-left transition hover:border-brand-600/60"
                >
                  <span>
                    <span className="block text-sm font-semibold text-brand-700">给爸妈看</span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-500">
                      大字版：只讲去哪几个地方、走多久、厕所在哪
                    </span>
                  </span>
                  <span className="shrink-0 text-lg text-brand-700" aria-hidden>›</span>
                </button>
                {!jointBlocked && <AgentPanel agent={agent} stops={verifiedStops} />}
              </>
            )}

            {/* ── 调整页：改走多远 ─────────────────────────────── */}
            {hasRoute && planPage === "adjust" && !jointBlocked && (
              <>
                {preflightNote && (
                  <p className="rounded-xl bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-ink-700 ring-1 ring-amber-500/25">
                    {preflightNote}
                  </p>
                )}
                {verifiedRoute.report?.ok && verifiedRoute.report.facts?.factsId ? (
                  <WalkLimitPanel
                    factsId={verifiedRoute.report.facts.factsId}
                    currentWalkMeters={activeItinerary?.totalWalkMeters ?? null}
                    currentLongestSegmentMeters={
                      activeItinerary?.legs?.length
                        ? Math.max(...activeItinerary.legs.map((leg) => leg.distanceMeters))
                        : null
                    }
                    onResolved={(itinerary, applied) => {
                      setSoloOverride(itinerary);
                      setPreflightNote(null);
                      setPreflightCap(applied.maxWalkMeters);
                      setPreflightSegmentCap(applied.maxSegmentMeters);
                    }}
                  />
                ) : (
                  <p className="rounded-xl bg-paper px-3 py-2 text-[11px] text-ink-500">这份报告没有可复用的事实集，需要重新生成一次才能调整。</p>
                )}
              </>
            )}

            {/* ── 更多页：类别、重新发现、双人协商、技术细节 ────── */}
            {hasRoute && planPage === "advanced" && !jointBlocked && (
              <>
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

          {/* 数据来源与调试面板属于「更多」：首屏不该出现技术细节 */}
          {planPage === "advanced" && (
            <>
              <DataSourcePanel
                adapterNotes={[...journey.adapterNotes, agentDataSourceNote(agent.status)]}
              />
              <DebugPanel
                discover={discover}
                verified={verifiedRoute}
                agent={agent}
                mapConfig={mapConfig}
                geometryNote={geometry.note}
                demo={
                  activeItinerary
                    ? {
                        label: journey.route.label,
                        totalMinutes: journey.route.totalMinutes,
                        stops: journey.pois.map((poi) => ({ name: poi.name, stayMinutes: poi.stayMinutes })),
                      }
                    : null
                }
              />
            </>
          )}
        </div>
      </main>

      {/* 大字版：全屏覆盖，只讲去哪、走多久、厕所在哪 */}
      <ElderView
        open={elderOpen}
        onClose={() => setElderOpen(false)}
        itinerary={activeItinerary}
        toilets={verifiedRoute.report?.toilets}
        limitMeters={preflightCap}
        segmentLimitMeters={preflightSegmentCap}
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
