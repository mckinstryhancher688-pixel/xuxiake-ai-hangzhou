import type { AmapPoi, DiscoveredPoi } from "@/lib/types";
import type { FactSet, PartyConditions, Role, JointSolve } from "@/lib/negotiation/types";
import type { PlanState } from "@/lib/negotiation/plan-state";

export const TRIP_HEADER = "x-trip-token";
export const LIMITS = { materials: 20, images: 5, imageBytes: 5 * 1024 * 1024, textChars: 10000,
  processingPerDay: 20, asksPerDay: 30, aiPerHour: 40, candidates: 6 } as const;
export type JobStatus = "pending" | "processing" | "ready" | "failed";
export interface SourceChunk {
  id: string; materialId: string; materialVersion: number; text: string; ordinal: number;
  vector: number[] | null; model: string | null;
}
export interface Mention {
  name: string; reason: string; quote: string; stance: "recommend" | "avoid" | "mention";
}
export interface Material {
  id: string; owner: Role; title: string; kind: "text" | "image"; sourceUrl: string | null;
  sourceKey: string; contentHash: string; text: string; originalText: string;
  image: { file: string; mime: string; bytes: number } | null;
  version: number; status: JobStatus; indexStatus: JobStatus; error: string | null;
  mentions: Mention[]; chunks: SourceChunk[]; createdAt: string; deletedAt: string | null;
}
export interface PoiCandidate {
  id: string; name: string; aliases: string[]; selected: boolean;
  materialIds: string[]; flyai: DiscoveredPoi | null; amap: AmapPoi | null;
  choices: AmapPoi[]; identity: "pending" | "ambiguous" | "verified";
  identityMeasuredAt: string | null;
  flyaiMeasuredAt?: string | null;
  crossCheck?: { status: string; reason: string | null; routable: boolean };
}
export interface ExternalEvidence<T> { provider: "amap" | "flyai"; acquiredAt: string; value: T }
export interface TripMember { role: Role; joinedAt: string; submitted: boolean }
export interface VerifyQuote {
  id: string; signature: string; candidateIds: string[]; expiresAt: string;
  placeUpperBound: number; walkingUpperBound: number; initial: boolean;
}
export interface TripWorkspace {
  id: string; title: string; city: "杭州"; createdAt: string; expiresAt: string;
  version: number; knowledgeVersion: number;
  members: { A: TripMember; B: TripMember | null };
  conditions: { A: PartyConditions; B: PartyConditions | null };
  materials: Material[]; candidates: PoiCandidate[];
  plan: PlanState | null; facts: FactSet | null; quote: VerifyQuote | null;
  lastSolve?: JointSolve | null;
  /** Cumulative incremental measurements survive replacing a facts set or plan. */
  incrementalWalking: number; initialMeasured: boolean;
}
export interface TripJob {
  id: string; tripId: string; owner: Role; kind: "material" | "verify" | "enrich" | "ask" | "explain";
  status: JobStatus; input: Record<string, unknown>; result: unknown; error: string | null;
  requestKey: string; createdAt: string; updatedAt: string;
}
export interface Citation {
  chunkId: string; materialId: string; title: string; owner: Role; ordinal: number;
  text: string; image: boolean; sourceUrl: string | null;
}
export interface TripAnswer {
  answer: string; citations: Citation[]; retrievalMode: "hybrid" | "keyword-only";
  notice: string | null; knowledgeVersion: number; routeRevision: number | null;
}
export interface TripExplanation {
  revision: number; contentHash: string; knowledgeVersion: number; headline: string; details: string[];
  next: string; notice: string | null; sources: { title: string; materialId: string }[];
}
export interface TripSnapshot {
  trip: TripWorkspace; role: Role; jobs: TripJob[];
  invitation: { pending: boolean; expiresAt: string | null };
  execution: { allowed: boolean; reason: string };
}
