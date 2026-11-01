"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { TRIP_HEADER, type Material } from "@/lib/trips/types";

type Act = (action: string, input?: Record<string, unknown>, method?: string, form?: FormData) => Promise<unknown>;
export function TripMaterials({ materials, role, tripId, credential, busy, act }: {
  materials: Material[]; role: "A" | "B"; tripId: string; credential: string; busy: boolean; act: Act;
}) {
  const [kind, setKind] = useState<"text" | "image">("text");
  const [title, setTitle] = useState(""), [text, setText] = useState(""), [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const form = kind === "image" && file ? new FormData() : undefined;
    if (form && file) { form.set("title", title); form.set("sourceUrl", url); form.set("image", file); }
    const result = await act("materials", { title, text, sourceUrl: url }, "POST", form);
    if (result) { setText(""); setTitle(""); setUrl(""); setFile(null); if (imageInput.current) imageInput.current.value = ""; }
  }
  return <div className="space-y-6">
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-white p-5">
      <h2 className="text-lg font-semibold">放入一份攻略</h2>
      <p className="text-sm leading-6 text-ink-500">文字或清晰截图都可以。AI 会整理地点并保留出处；这里不会自动查询飞猪或高德。每人也可以只看方案、不上传资料。</p>
      <div className="flex gap-3">
        <button type="button" aria-pressed={kind === "text"} onClick={() => setKind("text")} className={"rounded-lg border px-3 py-2 " + (kind === "text" ? "border-brand-700 text-brand-700" : "border-line")}>粘贴文字</button>
        <button type="button" aria-pressed={kind === "image"} onClick={() => setKind("image")} className={"rounded-lg border px-3 py-2 " + (kind === "image" ? "border-brand-700 text-brand-700" : "border-line")}>上传截图</button>
      </div>
      <label className="block text-sm">资料标题<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="例如：西湖傍晚散步攻略" className="mt-1 w-full rounded-lg border border-line p-2.5" /></label>
      {kind === "text" ? <label className="block text-sm">攻略原文<textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={10000} required rows={7} className="mt-1 w-full rounded-lg border border-line p-3" /></label>
        : <label className="block text-sm">攻略截图（JPEG、PNG、WebP，最多 5 MB）<input ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-2 block w-full text-sm" /></label>}
      <label className="block text-sm">原文链接（选填，仅保存出处）<input type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2000} className="mt-1 w-full rounded-lg border border-line p-2.5" /></label>
      <button disabled={busy || (kind === "image" && !file)} className="rounded-lg bg-brand-700 px-4 py-2.5 text-white disabled:opacity-50">{busy ? "正在保存…" : "保存并整理"}</button>
      <p className="text-xs text-ink-500">每个旅行最多 20 份资料，其中截图最多五张。PDF 暂未开放。</p>
    </form>
    <div className="space-y-3">
      {materials.filter((m) => !m.deletedAt).map((material) => <MaterialCard key={material.id} material={material} own={material.owner === role} busy={busy} act={act} tripId={tripId} credential={credential} />)}
      {!materials.some((m) => !m.deletedAt) ? <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-ink-500">还没有资料。放入你收藏的第一份攻略，或先去挑选地点。</p> : null}
    </div>
  </div>;
}
function MaterialCard({ material, own, busy, act, tripId, credential }: { material: Material; own: boolean; busy: boolean; act: Act; tripId: string; credential: string }) {
  const [editing, setEditing] = useState(false), [correction, setCorrection] = useState(material.text);
  return <article id={"material-" + material.id} className="rounded-xl border border-line bg-white p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{material.title}</h3><span className="text-xs text-ink-500">{material.owner === "A" ? "发起人" : "搭子"}提供 · {({ pending: "等待整理", processing: "正在整理", ready: "已整理", failed: "待处理" })[material.status]}</span></div>
    {material.error ? <p role="status" className="mt-3 text-sm text-amber-800">{material.error}</p> : null}
    <details className="mt-3"><summary className="cursor-pointer text-sm text-brand-700">查看原文与出处</summary>
      {material.image ? <PrivateImage tripId={tripId} materialId={material.id} credential={credential} /> : null}
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7">{material.text || "识别文字尚未生成，可先查看原图。"}</p>
      {material.sourceUrl ? <a href={material.sourceUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm text-brand-700 underline">打开原文链接</a> : null}
    </details>
    {material.mentions.length ? <p className="mt-3 text-sm text-ink-500">提到的地点：{material.mentions.map((m) => m.name + (m.stance === "avoid" ? "（原文不推荐）" : "")).join("、")}</p> : null}
    {own ? <div className="mt-4 flex flex-wrap gap-4 text-sm">
      <button disabled={busy} onClick={() => { setCorrection(material.text); setEditing(!editing); }} className="text-brand-700">修正识别文字</button>
      <button disabled={busy} onClick={() => { if (window.confirm("删除这份资料？已采用的路线会保留，检索不再引用它。")) void act("materials/" + material.id, {}, "DELETE"); }} className="text-red-700">删除自己的资料</button>
    </div> : null}
    {editing ? <form onSubmit={async (e) => { e.preventDefault(); const result = await act("materials/" + material.id, { text: correction }, "PATCH"); if (result) setEditing(false); }} className="mt-3 space-y-3">
      <label className="block text-sm">修正后的原文<textarea maxLength={10000} required rows={6} value={correction} onChange={(e) => setCorrection(e.target.value)} className="mt-1 w-full rounded-lg border border-line p-3" /></label>
      <button disabled={busy} className="rounded-lg border border-brand-700 px-3 py-2 text-brand-700">保存纠错并重新整理</button>
    </form> : null}
  </article>;
}
export function PrivateImage({ tripId, materialId, credential }: { tripId: string; materialId: string; credential: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let current: string | null = null;
    const controller = new AbortController();
    fetch("/api/trips/" + tripId + "/materials/" + materialId + "/image", { headers: { [TRIP_HEADER]: credential }, signal: controller.signal })
      .then(async (r) => { if (!r.ok) return; const blob = await r.blob(); if (!controller.signal.aborted) { current = URL.createObjectURL(blob); setUrl(current); } })
      .catch(() => {});
    return () => { controller.abort(); if (current) URL.revokeObjectURL(current); };
  }, [tripId, materialId, credential]);
  // Protected member-only blobs cannot use the public Next Image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="用户上传的攻略原图" className="mt-3 max-h-[600px] w-auto rounded-lg border border-line object-contain" /> : <p className="mt-2 text-xs text-ink-500">原图正在加载或暂不可用。</p>;
}
