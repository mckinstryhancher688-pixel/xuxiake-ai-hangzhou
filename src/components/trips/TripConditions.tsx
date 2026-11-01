"use client";

import { useState, type FormEvent } from "react";
import type { PartyConditions, Role } from "@/lib/negotiation/types";
import type { PoiCandidate } from "@/lib/trips/types";
import { COST_SCOPE_NOTICE } from "@/lib/negotiation/types";

export function TripConditions({ role, initial, candidates, busy, onSave }: {
  role: Role; initial: PartyConditions; candidates: PoiCandidate[]; busy: boolean;
  onSave: (conditions: PartyConditions) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(initial);
  function hardList(key: "mustVisit" | "neverAccept", id: string, checked: boolean) {
    setDraft((d) => ({ ...d, hard: { ...d.hard, [key]: checked ? [...d.hard[key], id] : d.hard[key].filter((v) => v !== id) } }));
  }
  async function submit(e: FormEvent) { e.preventDefault(); await onSave(draft); }
  return <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-white p-5">
    <h2 className="text-lg font-semibold">只填写你自己的选择</h2>
    <p className="text-sm text-ink-500">你是{role === "A" ? "发起人" : "受邀搭子"}。愿意跟随，也仍然保留你的步行、时间和地点底线。</p>
    <div className="grid gap-4 sm:grid-cols-3">
      <label className="text-sm">步行最多（公里，可不填）<input type="number" min="0" max="100" step="0.1" value={draft.hard.maxWalkMeters === null ? "" : draft.hard.maxWalkMeters / 1000}
        onChange={(e) => setDraft((d) => ({ ...d, hard: { ...d.hard, maxWalkMeters: e.target.value === "" ? null : Math.round(Number(e.target.value) * 1000) } }))} className="mt-2 w-full rounded-lg border border-line p-2.5" /></label>
      <label className="text-sm">最晚结束（北京时间，可不填）<input type="time" value={draft.hard.latestEndMinutes === null ? "" : String(Math.floor(draft.hard.latestEndMinutes / 60)).padStart(2, "0") + ":" + String(draft.hard.latestEndMinutes % 60).padStart(2, "0")}
        onChange={(e) => { const [h, m] = e.target.value.split(":").map(Number); setDraft((d) => ({ ...d, hard: { ...d.hard, latestEndMinutes: e.target.value ? h * 60 + m : null } })); }} className="mt-2 w-full rounded-lg border border-line p-2.5" /></label>
      <label className="text-sm">游玩倾向<select value={draft.bias} onChange={(e) => setDraft((d) => ({ ...d, bias: e.target.value as PartyConditions["bias"] }))} className="mt-2 w-full rounded-lg border border-line p-2.5"><option value="neutral">没有特定倾向</option><option value="see_more">尽量多看几个</option><option value="walk_less">尽量少走路</option></select></label>
    </div>
    {candidates.map((c) => <fieldset key={c.id} className="rounded-lg border border-line p-3">
      <legend className="px-1 text-sm font-medium">{c.name}</legend>
      <label className="text-sm">我的偏好<select value={draft.soft[c.id] ?? ""} onChange={(e) => setDraft((d) => { const soft = { ...d.soft }; if (e.target.value) soft[c.id] = e.target.value as "prefer" | "ok" | "avoid" | "follow"; else delete soft[c.id]; return { ...d, soft }; })} className="ml-2 rounded border border-line p-2">
        <option value="">尚未评价</option><option value="prefer">特别想去</option><option value="ok">可以去</option><option value="avoid">不太想去</option><option value="follow">愿意跟随</option>
      </select></label>
      <div className="mt-3 flex flex-wrap gap-5 text-sm">
        <label><input type="checkbox" checked={draft.hard.mustVisit.includes(c.id)} onChange={(e) => hardList("mustVisit", c.id, e.target.checked)} /> 必须去</label>
        <label><input type="checkbox" checked={draft.hard.neverAccept.includes(c.id)} onChange={(e) => hardList("neverAccept", c.id, e.target.checked)} /> 绝不接受</label>
      </div>
    </fieldset>)}
    <details className="text-xs leading-6 text-ink-500"><summary className="cursor-pointer">距离、时间与费用的统计范围</summary>{COST_SCOPE_NOTICE}</details>
    <button disabled={busy} className="rounded-lg bg-brand-700 px-4 py-2.5 text-white disabled:opacity-50">提交我的条件（空白即明确无附加条件）</button>
  </form>;
}
