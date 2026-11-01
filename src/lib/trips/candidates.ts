import { LIMITS, type PoiCandidate, type TripWorkspace } from "./types.ts";
import type { Role } from "../negotiation/types.ts";

export interface CandidateReason { role: Role; kind: "must" | "prefer" }
export interface CandidateSelection {
  ids: string[];
  manualCount: number;
  automatic: { id: string; name: string; reasons: CandidateReason[] }[];
  reasons: Record<string, CandidateReason[]>;
}

/** One shared definition for the visible selection and the server's routing universe. */
export function candidateSelection(trip: Pick<TripWorkspace, "candidates" | "conditions">): CandidateSelection {
  const manual = new Set(trip.candidates.filter((c) => c.selected).map((c) => c.id));
  const ids = new Set(manual), reasons: Record<string, CandidateReason[]> = {};
  for (const role of ["A", "B"] as const) {
    const party = trip.conditions[role];
    if (!party) continue;
    for (const key of new Set([...party.hard.mustVisit, ...Object.keys(party.soft).filter((id) => party.soft[id] === "prefer")])) {
      ids.add(key);
      (reasons[key] ??= []).push({ role, kind: party.hard.mustVisit.includes(key) ? "must" : "prefer" });
    }
  }
  return { ids: [...ids], manualCount: manual.size, reasons,
    automatic: [...ids].filter((id) => !manual.has(id)).map((id) => ({
      id, name: trip.candidates.find((c) => c.id === id)?.name ?? id, reasons: reasons[id] ?? [],
    })) };
}

export function candidateReasonText(reasons: CandidateReason[]): string {
  return reasons.map((r) => (r.role === "A" ? "发起人" : "搭子") + (r.kind === "must" ? "必须去" : "特别想去")).join("、");
}

export function candidateLimitMessage(selection: CandidateSelection): string {
  const extra = selection.automatic.length;
  return `本轮最多六个地点，当前实际待规划 ${selection.ids.length} 个：手动勾选 ${selection.manualCount} 个` +
    (extra ? `，另有 ${extra} 个因已提交的“必须去／特别想去”自动加入（${selection.automatic.map((c) => c.name).join("、")}）` : "") +
    `。请移出 ${Math.max(0, selection.ids.length - LIMITS.candidates)} 个；自动保留的地点需由本人先修改并提交个人选择。`;
}

export function selectedCandidates(candidates: PoiCandidate[], selection: CandidateSelection): PoiCandidate[] {
  const ids = new Set(selection.ids);
  return candidates.filter((c) => ids.has(c.id));
}
