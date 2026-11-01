"use client";

import { useState } from "react";
import { MapCanvas } from "@/components/map/MapCanvas";
import { useMapJsConfig } from "@/hooks/useMapJsConfig";
import { buildVerifiedScene } from "@/lib/map/verified-scene";
import type { VerifiedItinerary } from "@/lib/types";

export function TripRouteMap({ itinerary }: { itinerary: VerifiedItinerary }) {
  const config = useMapJsConfig();
  const [failure, setFailure] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const scene = buildVerifiedScene(itinerary, [], active);
  return <div className="h-80 overflow-hidden rounded-xl border border-line">
    <MapCanvas scene="verified" mapConfig={config} sdkFailure={failure} onFailed={setFailure}
      features={scene.features} routeLines={scene.routeLines} undrawnLegs={scene.undrawnLegs}
      lakeOutline={[]} streets={[]} activeFeatureId={active} onSelectFeature={setActive} />
  </div>;
}
