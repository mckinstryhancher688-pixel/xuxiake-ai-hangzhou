"use client";

import { useCallback, useMemo, useState } from "react";
import { ActionBar } from "@/components/ActionBar";
import { AgentPanel } from "@/components/AgentPanel";
import { DataSourcePanel } from "@/components/DataSourcePanel";
import { DebugPanel } from "@/components/DebugPanel";
import { DiscoverPanel } from "@/components/DiscoverPanel";
import { ExplorePanel } from "@/components/ExplorePanel";
import { ItineraryPanel } from "@/components/ItineraryPanel";
import { MapPanel } from "@/components/MapPanel";
import { SiteHeader } from "@/components/SiteHeader";
import { VerifiedRoutePanel } from "@/components/VerifiedRoutePanel";
import { useAgent } from "@/hooks/useAgent";
import { agentDataSourceNote } from "@/lib/agent";
import { useDiscover } from "@/hooks/useDiscover";
import { useJourney } from "@/hooks/useJourney";
import { useMapJsConfig } from "@/hooks/useMapJsConfig";
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
  const agent = useAgent(
    journey.context.city,
    journey.context.interests,
    verifiedRoute.report,
  );
  const verifiedStops = (agent.activeItinerary?.stops ?? []).map((stop) => ({
    flyaiId: stop.flyaiId,
    name: stop.name,
    matchStatus: stop.matchStatus,
  }));

  // 地图跟着「当前生效行程」走：智能体调整过就用调整后的，否则用核验结果；
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

      <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 px-4 py-4 sm:px-6 lg:grid lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-start">
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

          <div
            className={`${tab === "plan" ? "flex" : "hidden"} flex-col gap-4 lg:flex lg:overflow-y-auto lg:pr-1`}
          >
            {/* 主界面只留一条路线：核验出结果之后，阶段一的演示行程与预写讲解就退到调试记录里，
                否则屏幕上会同时出现「地图上一条、面板里另一条」。 */}
            {!activeItinerary && (
              <ItineraryPanel
                routeLabel={journey.route.label}
                routeSummary={journey.route.summary}
                totalWalkMeters={journey.route.totalWalkMeters}
                totalMinutes={journey.route.totalMinutes}
                pois={journey.pois}
                activePoi={journey.activePoi}
                visitedIds={journey.visitedIds}
                legFrom={journey.legFrom}
                onSelect={journey.selectPoi}
              />
            )}

            <DiscoverPanel cityName={journey.context.city} discover={discover} />

            <VerifiedRoutePanel
              cityName={journey.context.city}
              route={verifiedRoute}
              activeItinerary={activeItinerary}
              routeAdjusted={routeAdjusted}
              selectedStopId={agent.selectedStopId}
              arrivedStopIds={agent.arrivedStopIds}
              onSelectStop={agent.selectStop}
            />

            <AgentPanel agent={agent} stops={verifiedStops} />

            {activeItinerary ? (
              <p className="rounded-2xl border border-line bg-paper p-3 text-[11px] leading-relaxed text-ink-500">
                当前生效的路线就是「高德核验路线」面板与左侧地图里的这一条（{activeItinerary.stops.length} 站 /{" "}
                {activeItinerary.totalMinutes} 分钟）。阶段一的演示行程与它的预写讲解已经撤下主界面，
                只保留在下面的开发调试面板里。
              </p>
            ) : (
              <ExplorePanel
                poi={journey.activePoi}
                exploration={journey.exploration}
                explorationStatus={journey.explorationStatus}
              />
            )}
          </div>

          {!activeItinerary && (
            <div className="sticky bottom-3 z-10 mt-auto lg:static lg:mt-0">
              <ActionBar
                activePoiName={journey.activePoi.name}
                isActiveVisited={journey.isActiveVisited}
                explorationStatus={journey.explorationStatus}
                routeId={journey.route.id}
                remainingMinutes={journey.remainingMinutes}
                totalMinutes={journey.context.totalMinutes}
                onArrived={journey.markArrived}
                onToggleRoute={journey.toggleRoute}
              />
            </div>
          )}

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
