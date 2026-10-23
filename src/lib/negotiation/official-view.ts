import type { PlanSnapshot, RevisionView } from "../plan-api";

/** 角色页只显示服务端已放行的正式版本；待确认提案不能替代它。 */
export function executableOfficial(
  snapshot: Pick<PlanSnapshot, "canExecute" | "official" | "officialRevision"> | null,
  busy: boolean,
  syncError: string | null,
): RevisionView | null {
  if (busy || syncError || !snapshot?.canExecute.allowed || !snapshot.official) return null;
  const official = snapshot.official;
  if (official.status !== "jointly-confirmed" || official.suspended || snapshot.officialRevision !== official.revision) return null;
  return official;
}
