"use client";

import { useMemo } from "react";
import {
  createProjection,
  projectPath,
  toSvgPoints,
} from "@/lib/map/projection";
import type { MapFeature, MapViewProps } from "./types";

const STATE_STYLE = {
  visited: { fill: "#0d9488", ring: "#99f6e4" },
  active: { fill: "#f59e0b", ring: "#fde68a" },
  upcoming: { fill: "#ffffff", ring: "#cbd5e1" },
} as const;

/**
 * 演示用 SVG 地图。纯展示 + 点击回调，不含任何业务状态。
 * ⚠️ 底图（湖岸、道路）来自 src/data/mock/geography.ts 的手绘示意折线。
 */
export function MockSvgMap({
  features,
  routeLines,
  lakeOutline,
  streets,
  activeFeatureId,
  onSelectFeature,
}: MapViewProps) {
  const { projection, lakePoints, streetPaths } = useMemo(() => {
    const all = [
      ...lakeOutline,
      ...streets.flatMap((s) => s.path),
      ...features.map((f) => f.position),
      ...routeLines.flatMap((l) => l.points),
    ];
    const projection = createProjection(all, 100, 100, 9);
    return {
      projection,
      lakePoints: toSvgPoints(projectPath(projection, lakeOutline)),
      streetPaths: streets.map((s) => ({
        name: s.name,
        points: toSvgPoints(projectPath(projection, s.path)),
        labelAt: projection.project(s.path[0]),
        // 短街（如平海路）的标签会和 POI 标记挤在一起，只画线不写字
        showLabel: s.path.length >= 4,
      })),
    };
  }, [features, lakeOutline, routeLines, streets]);

  const lines = routeLines.map((line) => ({
    ...line,
    points: toSvgPoints(projectPath(projection, line.points)),
  }));

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full select-none"
      role="group"
      aria-label="西湖湖滨漫游示意地图"
    >
      <defs>
        <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d7eef2" />
          <stop offset="100%" stopColor="#bfe4ea" />
        </linearGradient>
      </defs>

      <rect width="100" height="100" fill="#f6f7f4" />

      <polygon points={lakePoints} fill="url(#lake)" stroke="#a8d5dd" strokeWidth="0.3" />
      <text x="24" y="58" className="fill-[#7fb2bd]" fontSize="3.2" letterSpacing="0.4">
        西 湖
      </text>

      {streetPaths.map((street) => (
        <g key={street.name}>
          <polyline
            points={street.points}
            fill="none"
            stroke="#e2e5de"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <polyline
            points={street.points}
            fill="none"
            stroke="#ffffff"
            strokeWidth="0.9"
            strokeLinecap="round"
          />
          {street.showLabel && (
            <text
              x={street.labelAt.x}
              y={street.labelAt.y - 1.6}
              className="fill-[#9aa39b]"
              fontSize="2.1"
            >
              {street.name}
            </text>
          )}
        </g>
      ))}

      {lines.map((line) => (
        <polyline
          key={line.id}
          points={line.points}
          fill="none"
          stroke={line.state === "walked" ? "#0d9488" : "#94a3b8"}
          strokeWidth={line.state === "walked" ? 1.5 : 1.1}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={line.state === "walked" ? undefined : "2 1.6"}
          opacity={line.state === "walked" ? 0.95 : 0.7}
        />
      ))}

      {features.map((feature) => {
        const { x, y } = projection.project(feature.position);
        const isActive = feature.id === activeFeatureId;
        return feature.kind === "metro" ? (
          <MetroMarker key={feature.id} x={x} y={y} feature={feature} />
        ) : (
          <PoiMarker
            key={feature.id}
            x={x}
            y={y}
            feature={feature}
            isActive={isActive}
            onSelect={onSelectFeature}
          />
        );
      })}
    </svg>
  );
}

function MetroMarker({
  x,
  y,
  feature,
}: {
  x: number;
  y: number;
  feature: MapFeature;
}) {
  return (
    <g>
      <rect
        x={x - 1.1}
        y={y - 1.1}
        width="2.2"
        height="2.2"
        rx="0.5"
        fill="#ffffff"
        stroke="#64748b"
        strokeWidth="0.45"
      />
      <text x={x} y={y + 0.75} textAnchor="middle" fontSize="1.6" className="fill-[#475569]">
        M
      </text>
      <text x={x + 2} y={y + 0.9} fontSize="2.1" className="fill-[#64748b]">
        {feature.name}
      </text>
    </g>
  );
}

function PoiMarker({
  x,
  y,
  feature,
  isActive,
  onSelect,
}: {
  x: number;
  y: number;
  feature: MapFeature;
  isActive: boolean;
  onSelect: (id: string) => void;
}) {
  const style = STATE_STYLE[feature.state];
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${feature.order ? `第 ${feature.order} 站 ` : ""}${feature.name}`}
      aria-pressed={isActive}
      className="cursor-pointer outline-none"
      onClick={() => onSelect(feature.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(feature.id);
        }
      }}
    >
      {isActive && (
        <circle className="marker-halo" cx={x} cy={y} r="4.2" fill={style.fill} opacity="0.35" />
      )}
      <circle
        cx={x}
        cy={y}
        r={isActive ? 3.4 : 2.8}
        fill={style.fill}
        stroke={isActive ? "#b45309" : style.ring}
        strokeWidth="0.8"
      />
      {feature.order && (
        <text
          x={x}
          y={y + 1}
          textAnchor="middle"
          fontSize="2.6"
          fontWeight="600"
          className={feature.state === "upcoming" ? "fill-[#334155]" : "fill-white"}
        >
          {feature.order}
        </text>
      )}
      <text
        x={x}
        y={y - 4.4}
        textAnchor="middle"
        fontSize="2.5"
        fontWeight={isActive ? 700 : 500}
        className={isActive ? "fill-[#92400e]" : "fill-[#1f2937]"}
        stroke="#ffffff"
        strokeWidth="0.7"
        paintOrder="stroke"
      >
        {feature.name}
      </text>
    </g>
  );
}
