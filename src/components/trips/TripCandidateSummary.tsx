import { LIMITS } from "@/lib/trips/types";
import { candidateReasonText, type CandidateSelection } from "@/lib/trips/candidates";

export function TripCandidateSummary({ selection, onEdit }: { selection: CandidateSelection; onEdit?: () => void }) {
  const count = selection.ids.length, exceeded = count > LIMITS.candidates;
  return <section aria-label="本轮路线候选" className={"space-y-2 rounded-lg border p-4 text-sm leading-7 " + (exceeded ? "border-amber-200 bg-amber-50 text-amber-950" : "border-line bg-paper")}>
    <p className="font-semibold" role="status">本轮待规划：{count} / {LIMITS.candidates} 个地点{exceeded ? `（超出 ${count - LIMITS.candidates} 个）` : ""}</p>
    <p>手动勾选 {selection.manualCount} 个{selection.automatic.length ? `，另有 ${selection.automatic.length} 个因已提交的个人选择自动加入。` : "，没有额外自动加入的地点。"}最终路线最多安排 4 站。</p>
    {selection.automatic.length ? <ul className="list-inside list-disc">{selection.automatic.map((c) => <li key={c.id}>{c.name}：{candidateReasonText(c.reasons)}</li>)}</ul> : null}
    {exceeded ? <p>请减少 {count - LIMITS.candidates} 个候选后再规划。自动保留的地点需由本人修改并提交下方的“特别想去／必须去”，系统不会替任何一方取消。</p> : null}
    {onEdit ? <button type="button" onClick={onEdit} className="text-brand-700 underline">返回挑选地点和个人选择</button> : null}
  </section>;
}
