"use client";

import { useCallback, useMemo, useState } from "react";
import { AgentPanel } from "@/components/AgentPanel";
import { DataSourcePanel } from "@/components/DataSourcePanel";
import { DebugPanel } from "@/components/DebugPanel";
import { DiscoverPanel } from "@/components/DiscoverPanel";
import { ExplorePanel } from "@/components/ExplorePanel";
import { ItineraryPanel } from "@/components/ItineraryPanel";
import { MapPanel } from "@/components/MapPanel";
import { NegotiationPanel } from "@/components/NegotiationPanel";
import { PlanActionBar } from "@/components/PlanActionBar";
import { SiteHeader } from "@/components/SiteHeader";
import { VerifiedRoutePanel } from "@/components/VerifiedRoutePanel";
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

type MobileTab = "map" | "plan";

/** 已核验行程的免责说明与演示数据必须分开写，否则用户分不清哪条线是真的。 */
const VERIFIED_DISCLAIMER =
  "真实核验数据 · 点位坐标与步行折线均来自高德实测（折线沿真实道路，不是两点直线）；停留时长为模拟值，到达由你手动确认（不是真实 GPS）。";

export function JourneyApp() {
  const journey = useJourney();
  const [tab, setTab] = useState<MobileTab>("map");
  // 两个面板与调试面板共用同一份状态，所以在这里统一持有
  const discover = useDiscover(journey.context.city);
  const verifiedRoute = useVerifiedRoute(journey.context.city);
  const mapConfig = useMapJsConfig();
  // 双人协商挂在同一份已核验事实层上：不新建第二套数据，也不改单人链路
  const plan = usePlan();
  // 只有服务端判定「双方确认了同一个版本」时，这一版才成为正式执行路线。
  // 读的是服务端返回的 official 那一版，不退回更早的城市/类别结果，浏览器也不自行判定。
  const jointRoute = plan.snapshot?.canExecute.allowed ? (plan.snapshot.official?.itinerary ?? null) : null;
  const effectiveReport =
    jointRoute && verifiedRoute.report ? { ...verifiedRoute.report, itinerary: jointRoute } : verifiedRoute.report;
  // 只有双方确认的正式版本真的在屏幕上生效时，才把这条协商交给智能体：
  // 于是「我到了」读的就是地图与面板上那一份，不会再按 city/类别 回到旧的单人路线。
  const agentScope = useMemo(
    () => (jointRoute && plan.identity ? { planId: plan.identity.planId, token: plan.identity.token } : null),
    [jointRoute, plan.identity],
  );
  const agent = useAgent(
    journey.context.city,
    journey.context.interests,
    effectiveReport,
    agentScope,
  );
  const verifiedStops = (agent.activeItinerary?.stops ?? []).map((stop) => ({
    flyaiId: stop.flyaiId,
    name: stop.name,
    matchStatus: stop.matchStatus,
  }));
  // 双人协商挂在同一份已核验事实层上：不新建第二套数据，也不改单人链路
  // 地图跟着「当前生效行程」走：智能体调整过就用调整后的，否则用（可能已被双方确认版替换过的）核验结果；
  // 两者都还没有时只能继续显示演示行程，绝不把未核验的飞猪坐标画上去。
  const activeItinerary = agent.activeItinerary;
  // 调整过之后，核验面板显示的就是这一份；原始核验结果只在开发调试面板里保留。
  const routeAdjusted = activeItinerary !== null && activeItinerary !== (verifiedRoute.report?.itinerary ?? null);
  const scene: "verified" | "demo" = activeItinerary ? "verified" : "demo";
  const geometry = useRouteGeometry(activeItinerary);
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

      <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 px-4 pt-4 pb-40 sm:px-6 lg:grid lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-start lg:pb-4">
        <div
          className={`${tab === "map" ? "block" : "hidden"} lg:sticky lg:top-4 lg:block lg:h-[calc(100dvh-7.5rem)]`}
        >
          <MapPanel
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
          />
        </div>

        <div className="flex min-h-0 flex-col gap-4">
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-card p-1 lg:hidden">
            <TabButton active={tab === "map"} onClick={() => setTab("map")}>
              地图
            </TabButton>
            <TabButton active={tab === "plan"} onClick={() => setTab("plan")}>
              行程与探索
            </TabButton>
          </div>

          {/* 主流程按钮：窄屏钉在屏幕下沿（滚到哪一步都能点，首屏就一定看得见），
              桌面端回到右栏顶部跟随滚动。同一份组件、同一批按钮，不会出现两个入口。 */}
          <div className="fixed inset-x-0 bottom-0 z-30 p-3 lg:sticky lg:inset-x-auto lg:bottom-auto lg:top-4 lg:z-20 lg:p-0">
            <PlanActionBar route={verifiedRoute} agent={agent} categories={discover.selected} jointLocked={jointRoute !== null} />
          </div>

          <div
            className={`${tab === "plan" ? "flex" : "hidden"} flex-col gap-4 lg:flex lg:overflow-y-auto lg:pr-1`}
          >
            <DiscoverPanel cityName={journey.context.city} discover={discover} />

            <VerifiedRoutePanel
              cityName={journey.context.city}
              route={verifiedRoute}
              categories={discover.selected}
              activeItinerary={activeItinerary}
              routeAdjusted={jointRoute ? false : routeAdjusted}
              jointRevision={jointRoute ? (plan.snapshot?.officialRevision ?? null) : null}
              selectedStopId={agent.selectedStopId}
              arrivedStopIds={agent.arrivedStopIds}
              onSelectStop={agent.selectStop}
            />

            <AgentPanel agent={agent} stops={verifiedStops} />

            <NegotiationPanel plan={plan} factsId={verifiedRoute.report?.facts?.factsId ?? null} />

            {/* 阶段一的演示链路（预写行程与讲解）只在还没有真实路线时兜底显示，
                核验出结果之后整块撤下主界面，只保留在下面调试面板里，避免屏幕上并排两条路线。 */}
            {!activeItinerary && (
              <>
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
        </div>
      </main>
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
