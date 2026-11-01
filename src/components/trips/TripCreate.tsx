"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function TripCreate() {
  const router = useRouter();
  const [title, setTitle] = useState("杭州半日同行");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const response = await fetch("/api/trips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      router.push("/trips/" + data.trip.id + "#token=" + encodeURIComponent(data.token));
    } catch (e) { setError(e instanceof Error ? e.message : "创建未完成。"); setBusy(false); }
  }
  return <form onSubmit={submit} className="space-y-5 rounded-2xl border border-line bg-white p-6 shadow-sm">
    <label className="block text-sm font-medium">这次旅行叫什么
      <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} className="mt-2 w-full rounded-lg border border-line px-3 py-3" />
    </label>
    <p className="text-sm leading-7 text-ink-500">先收集你喜欢的攻略和地点，需要时邀请一位搭子加入。对方可以补充，也可以只表达底线、看方案和确认。</p>
    <p className="text-xs text-ink-500">当前支持杭州半日步行。资料保留 30 天；创建空间不查询飞猪或高德。</p>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    <button disabled={busy} className="rounded-lg bg-brand-700 px-5 py-3 font-medium text-white disabled:opacity-50">{busy ? "正在创建…" : "开始这次旅行"}</button>
  </form>;
}
