import type { LatLng, RouteStart, VerifiedItinerary, VerifiedStop, WalkingLeg } from "@/lib/types";
import { BUFFER_MINUTES, BUDGET_MINUTES } from "./verification.ts";

/**
 * 行程装配是单人「生成我的路线」、单人「少走一点」与双人协商共用的唯一一套算法。
 * 放在这里而不是 server/verify.ts，是为了让纯函数层（求解、差异、状态机）
 * 能在不引入高德与飞猪依赖的前提下被测试。
 */
export function composeItinerary(
  start: RouteStart,
  stops: VerifiedStop[],
  legs: WalkingLeg[],
  assumedStart: Date,
): VerifiedItinerary {
  const totalWalkMinutes = legs.reduce((sum, leg) => sum + leg.durationMinutes, 0);
  const totalWalkMeters = legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
  const totalStayMinutes = stops.reduce((sum, stop) => sum + stop.stayMinutes, 0);
  const totalMinutes = totalWalkMinutes + totalStayMinutes + BUFFER_MINUTES;

  return {
    start,
    stops,
    legs,
    totalWalkMeters,
    totalWalkMinutes,
    totalStayMinutes,
    bufferMinutes: BUFFER_MINUTES,
    totalMinutes,
    budgetMinutes: BUDGET_MINUTES,
    feasible: totalMinutes <= BUDGET_MINUTES,
    assumedStartAt: assumedStart.toISOString(),
  };
}

export function legKey(fromId: string, toId: string): string {
  return `${fromId}->${toId}`;
}

/** 同一套字段口径：秒→分钟向上取整到至少 1 分钟，几何缺失就留空数组，绝不画直线。 */
export function toLeg(
  fromName: string,
  toName: string,
  from: LatLng,
  to: LatLng,
  data: {
    distanceMeters: number;
    durationSeconds: number;
    stepCount: number;
    firstInstruction: string | null;
    polyline: LatLng[];
  },
  fromCache: boolean,
): WalkingLeg {
  return {
    fromName,
    toName,
    from,
    to,
    distanceMeters: data.distanceMeters,
    durationMinutes: Math.max(1, Math.round(data.durationSeconds / 60)),
    durationSeconds: data.durationSeconds,
    stepCount: data.stepCount,
    firstInstruction: data.firstInstruction,
    polyline: data.polyline,
    fromCache,
  };
}
