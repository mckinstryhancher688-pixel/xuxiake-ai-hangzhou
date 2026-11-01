"use client";

import Link from "next/link";
import { useState } from "react";
import { useTripWorkspace } from "@/hooks/useTripWorkspace";
import { TripMaterials, PrivateImage } from "./TripMaterials";
import { TripConditions } from "./TripConditions";
import { TripRouteMap } from "./TripRouteMap";
import { emptyConditions, type PartyConditions } from "@/lib/negotiation/types";
import { stopIdOf } from "@/lib/types";
import type { TripAnswer, TripSnapshot, TripExplanation } from "@/lib/trips/types";
import { independentSourceCount } from "@/lib/trips/sources";

const steps = ["收集资料", "挑选地点", "调整路线", "确认行程"] as const;
export function TripWorkspaceClient({ tripId }: { tripId: string }) {
  const workspace = useTripWorkspace(tripId);
  const { snapshot, busy, error, act } = workspace;
  const [step, setStep] = useState(0), [invitation, setInvitation] = useState<string | null>(null);
  const [question, setQuestion] = useState(""), [copied, setCopied] = useState(false);
  const [showAnswer, setShowAnswer] = useState(false);
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  async function selectCandidate(candidateId: string, checked: boolean) {
    setSelection((old) => ({ ...old, [candidateId]: checked }));
    await act("candidates/" + candidateId, { selected: checked }, "PATCH");
    setSelection((old) => { const next = { ...old }; delete next[candidateId]; return next; });
  }
  async function copy(text: string) { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } }
  if (!workspace.ready) return <main className="p-10 text-sm">正在打开旅行空间…</main>;
  if (workspace.invite) return <main className="mx-auto max-w-xl space-y-5 px-5 py-16">
    <Link href="/trips" className="text-brand-700">徐霞客 AI</Link>
    <h1 className="text-2xl font-bold">{workspace.preview?.title ?? "一份旅行邀请"}</h1>
    <p className="text-sm leading-7">发起人邀请你一起制定杭州半日行程。你可以上传攻略，也可以只表达自己的底线、查看方案并确认。打开这个页面不会自动加入。</p>
    {error ? <p role="alert" className="text-red-700">{error}</p> : null}
    <button disabled={busy || !workspace.preview} onClick={() => void workspace.join()} className="rounded-lg bg-brand-700 px-5 py-3 text-white disabled:opacity-50">接受邀请，加入旅行</button>
  </main>;
  if (!snapshot || !workspace.credential) return <main className="mx-auto max-w-xl space-y-5 px-5 py-16">
    <h1 className="text-2xl font-bold">打开自己的旅行链接</h1>
    <p className="text-sm text-ink-500">{error ?? "此浏览器还没有访问凭据。请打开包含 # 后面内容的完整私有链接。"}</p>
    <Link href="/trips" className="text-brand-700 underline">开始新的旅行</Link>
  </main>;
  const { trip, role } = snapshot;
  const head = trip.plan?.revisions.find((r) => r.revision === trip.plan?.headRevision);
  const answerJob = snapshot.jobs.find((j) => j.kind === "ask" && j.status === "ready");
  const answer = answerJob?.result as TripAnswer | undefined;
  const explanation = snapshot.jobs.find((job) => job.kind === "explain" && job.status === "ready" && (job.result as TripExplanation)?.revision === head?.revision && (job.result as TripExplanation)?.contentHash === head?.contentHash && (job.result as TripExplanation)?.knowledgeVersion === trip.knowledgeVersion)?.result as TripExplanation | undefined;
  const recovery = typeof window === "undefined" ? "" : window.location.origin + "/trips/" + tripId + "#token=" + encodeURIComponent(workspace.credential);
  const myConditions = trip.conditions[role] ?? emptyConditions(role);
  return <main className="mx-auto max-w-5xl space-y-6 px-4 py-7 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><Link href="/" className="text-xs text-brand-700">徐霞客 AI</Link><h1 className="mt-2 text-2xl font-bold">{trip.title}</h1>
        <p className="mt-2 text-sm text-ink-500">杭州半日 · {role === "A" ? "我是发起人" : "我是受邀搭子"} · {trip.members.B ? "两位已加入" : "一个人先开始"}</p></div>
      {role === "A" && !trip.members.B ? <div className="space-y-2 text-right">
        <button disabled={busy} onClick={async () => { const data = await act("invitation") as { invite?: string } | null;
          if (data?.invite) setInvitation(window.location.origin + "/trips/" + tripId + "#invite=" + encodeURIComponent(data.invite)); }}
          className="rounded-lg border border-brand-700 bg-white px-4 py-2.5 text-sm text-brand-700 disabled:opacity-50">邀请一位搭子</button>
        {snapshot.invitation.pending ? <p className="text-xs text-ink-500">邀请待接受；重新生成会使旧邀请失效。</p> : null}
      </div> : null}
    </header>
    {invitation && !trip.members.B ? <section className="space-y-3 rounded-xl border border-brand-700 bg-white p-4">
      <label className="block text-sm font-medium">发给搭子的邀请链接<input readOnly value={invitation} className="mt-2 w-full rounded border border-line p-2 text-xs" /></label>
      <div className="flex gap-4 text-sm"><button onClick={() => void copy(invitation)} className="text-brand-700">{copied ? "已复制" : "复制邀请"}</button>
        <button disabled={busy} onClick={async () => { if (await act("invitation", {}, "DELETE")) setInvitation(null); }} className="text-ink-500">作废这条邀请</button></div>
      <p className="text-xs text-ink-500">对方明确加入后，原个人方案转为双人待确认。</p>
    </section> : null}
    <details className="text-xs text-ink-500"><summary className="cursor-pointer">保存我的私有恢复链接</summary>
      <p className="mt-2">这个链接代表你的身份，请自己保管，邀请搭子请使用上方邀请按钮。</p>
      <input readOnly aria-label="我的私有恢复链接" value={recovery} className="mt-2 w-full rounded border border-line p-2" />
      <button onClick={() => void copy(recovery)} className="mt-2 text-brand-700">复制我的恢复链接</button>
    </details>
    <nav aria-label="旅行规划步骤" className="grid grid-cols-4 gap-1 rounded-xl bg-white p-1 ring-1 ring-line">
      {steps.map((label, index) => <button key={label} aria-current={step === index ? "step" : undefined} onClick={() => setStep(index)}
        className={"rounded-lg px-1 py-3 text-xs sm:text-sm " + (step === index ? "bg-brand-700 font-medium text-white" : "text-ink-500")}>{index + 1}. {label}</button>)}
    </nav>
    {error ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
    {snapshot.jobs.some((j) => j.status === "pending" || j.status === "processing") ? <p role="status" className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">资料或查询正在处理，结果会自动更新。你可以继续查看已有内容。</p> : null}
    {step === 0 ? <TripMaterials materials={trip.materials} role={role} tripId={tripId} credential={workspace.credential} busy={busy} act={act} /> : null}
    {step === 1 ? <div className="space-y-6">
      <section className="space-y-4 rounded-xl border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">挑选要比较的地点</h2><p className="text-sm leading-7 text-ink-500">资料提及不等于你想去。勾选本轮要比较的地点，再分别填写偏好；双方必须去和特别想去的地点也会纳入本轮比较。首轮最多六个候选，路线最多四站。</p>
        <div className="flex flex-wrap gap-3">{["城市观光", "自然风光", "文创街区"].map((category) => <button disabled={busy} key={category}
          onClick={() => void act("enrich", { category })} className="rounded-lg border border-brand-700 px-3 py-2 text-sm text-brand-700 disabled:opacity-50">用飞猪补充{category}</button>)}</div>
        <p className="text-xs text-ink-500">点击以上按钮才会查询飞猪，并受缓存与额度限制。</p>
        {trip.candidates.map((candidate) => {
          const sources = trip.materials.filter((m) => candidate.materialIds.includes(m.id) && !m.deletedAt);
          const count = independentSourceCount(trip.materials, candidate.materialIds);
          return <article key={candidate.id} className="space-y-2 rounded-lg border border-line p-4">
            <label className="font-medium"><input type="checkbox" disabled={busy} checked={selection[candidate.id] ?? candidate.selected} onChange={(e) => void selectCandidate(candidate.id, e.target.checked)} className="mr-2" />{candidate.name}</label>
            <p className="text-xs leading-6 text-ink-500">{count ? count + " 份资料提及 · " : ""}{candidate.flyai ? "已关联飞猪信息" : "攻略来源，未关联飞猪数据"} · {candidate.identity === "verified" ? "高德身份已核实" : candidate.identity === "ambiguous" ? "需确认具体地点" : "尚未核验身份"}</p>
            {candidate.flyaiMeasuredAt ? <p className="text-xs text-ink-500">飞猪信息采集于 {new Date(candidate.flyaiMeasuredAt).toLocaleString("zh-CN")}</p> : null}
            {candidate.crossCheck ? <p className="text-xs leading-6 text-amber-800">跨平台比对：{candidate.crossCheck.reason}</p> : null}
            <p className="text-sm">发起人：{choiceOf(trip.conditions.A, candidate.id)}；搭子：{choiceOf(trip.conditions.B, candidate.id)}</p>
            {trip.conditions.B && ((trip.conditions.A.hard.mustVisit.includes(candidate.id) && trip.conditions.B.hard.neverAccept.includes(candidate.id)) || (trip.conditions.B.hard.mustVisit.includes(candidate.id) && trip.conditions.A.hard.neverAccept.includes(candidate.id))) ? <p className="text-sm text-red-700">一方必须去，另一方绝不接受：请各自协商底线，系统不会自动放宽。</p> : null}
            {!candidate.amap ? <button disabled={busy} onClick={() => { const name = window.prompt("修正地点名称（不会把改名当作身份核验）", candidate.name); if (name && name !== candidate.name) void act("candidates/" + candidate.id, { name }, "PATCH"); }} className="text-xs text-brand-700 underline">修正地点名称</button> : null}
            {!trip.plan && candidate.amap ? trip.candidates.filter((c) => c.id !== candidate.id && c.amap?.id === candidate.amap?.id).map((other) => <button key={other.id} disabled={busy} onClick={() => void act("merge", { keepId: candidate.id, removeId: other.id })} className="block text-xs text-brand-700 underline">与「{other.name}」合并（高德身份相同）</button>) : null}
            {candidate.materialIds.length && !sources.length ? <p className="text-xs text-amber-800">原资料已删除，已采用的地点仍保留。</p> : null}
            {sources.flatMap((m) => m.mentions.filter((mention) => mention.name === candidate.name || candidate.aliases.includes(mention.name)).map((mention, i) =>
              <p key={m.id + i} className="text-sm leading-6">来自《{m.title}》：{mention.stance === "avoid" ? "原文不推荐，" : ""}{mention.reason}<span className="ml-2 text-xs text-ink-500">“{mention.quote}”</span></p>))}
            {candidate.identity === "ambiguous" ? <label className="block text-sm">确认你指的是<select disabled={busy} value="" onChange={(e) => void act("candidates/" + candidate.id, { amapId: e.target.value }, "PATCH")} className="mt-2 w-full rounded border border-line p-2">
              <option value="">请选择高德返回的具体地点</option>{candidate.choices.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.adname} {p.address}</option>)}</select></label> : null}
          </article>;
        })}
        {!trip.candidates.length ? <p className="text-sm text-ink-500">攻略整理完成后，地点会出现在这里；也可以主动让飞猪补充。</p> : null}
      </section>
      <TripConditions key={role + JSON.stringify(myConditions)} role={role} initial={myConditions} candidates={trip.candidates} busy={busy} onSave={(conditions) => act("conditions", { conditions }, "PUT")} />
      <section className="rounded-xl border border-line bg-white p-5"><h2 className="font-semibold">双方已经表达的底线</h2><div className="mt-3 grid gap-3 sm:grid-cols-2">{(["A", "B"] as const).map((member) => { const condition = trip.conditions[member]; return <div key={member} className="rounded-lg bg-paper p-3 text-sm leading-7"><h3 className="font-medium">{member === "A" ? "发起人" : "受邀搭子"}</h3>{condition ? <><p>步行上限：{condition.hard.maxWalkMeters === null ? "未设置" : condition.hard.maxWalkMeters + " 米"}</p><p>必须去：{condition.hard.mustVisit.map((key) => trip.candidates.find((c) => c.id === key)?.name).join("、") || "未设置"}</p><p>绝不接受：{condition.hard.neverAccept.map((key) => trip.candidates.find((c) => c.id === key)?.name).join("、") || "未设置"}</p><p>倾向：{({ see_more: "多看几个", walk_less: "少走路", neutral: "没有特定倾向" })[condition.bias]}</p></> : <p>尚未提交条件，不代表没有异议。</p>}</div>; })}</div></section>
      <p className="text-sm text-ink-500">{trip.members.A.submitted ? "发起人已提交条件" : "发起人尚未提交条件"}；{trip.members.B ? (trip.members.B.submitted ? "搭子已提交条件" : "搭子尚未提交条件") : "搭子尚未加入"}。没有记录不表示同意。</p>
    </div> : null}
    {step >= 2 ? <div className="space-y-5">
      <section className="space-y-4 rounded-xl border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">{step === 2 ? "把选择变成真实路线" : "分别确认这份具体安排"}</h2>
        <p className="text-sm leading-7 text-ink-500">{snapshot.execution.allowed ? (trip.members.B ? "双方已确认" : "个人已确认") + " v" + trip.plan?.officialRevision : snapshot.execution.reason}</p>
        <div className="flex flex-wrap gap-3">
          <button disabled={busy} onClick={() => void act("quote")} className="rounded-lg border border-brand-700 px-4 py-2 text-sm text-brand-700">查看核验报价</button>
          <button disabled={busy || !trip.facts} onClick={() => void act("resolve")} className="rounded-lg border border-line px-4 py-2 text-sm">用已有数据重算</button>
          <button disabled={busy || !head} onClick={() => void act("shorten")} className="rounded-lg border border-line px-4 py-2 text-sm">提出少走一点的方案</button>
        </div>
        {trip.quote ? <div className="space-y-3 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">
          <p>本次上界：地点查询 {trip.quote.placeUpperBound} 次，步行路段 {trip.quote.walkingUpperBound} 段。缓存命中会更少，HTTP 重试另受小时额度限制。</p>
          <p>这是查询范围，不保证一定能找到满足条件的方案。后续新增路段超过六段时需要发起人批准。</p>
          <button disabled={busy || (!trip.quote.initial && trip.quote.walkingUpperBound > 6 && role !== "A")} onClick={() => void act("verify", { quoteId: trip.quote!.id, approveCost: role === "A" })}
            className="rounded-lg bg-brand-700 px-4 py-2 text-white disabled:opacity-50">按此报价核验路线</button>
        </div> : null}
      </section>
      {trip.lastSolve && (!head || head.suspended || !trip.lastSolve.best) ? <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm leading-7">
        <h3 className="font-semibold">{trip.lastSolve.kind === "hard-conflict" ? "当前条件存在真实冲突" : trip.lastSolve.kind === "not-measured" ? "还缺少路段证据" : "当前条件的求解结果"}</h3>
        <p>{trip.lastSolve.note}</p>{trip.lastSolve.unmet.map((hit, i) => <p key={i}>{hit.role}：{hit.text}</p>)}
        {trip.lastSolve.missingEdges.length ? <p>待核验：{trip.lastSolve.missingEdges.map((edge) => edge.name).join("、")}</p> : null}
        <p>原路线仅供比较，不能继续按旧确认执行；系统不会代替任何一方放宽条件。</p>
      </section> : null}
      {head ? <section className="space-y-4 rounded-xl border border-line bg-white p-5">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="text-lg font-semibold">方案 v{head.revision}</h3><span className="text-sm text-ink-500">{head.requiredConfirmers?.length === 1 ? "个人方案" : "双人方案"}</span></div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg bg-paper p-3"><strong className="block text-lg">{(head.itinerary.totalWalkMeters / 1000).toFixed(2)} km</strong><span className="text-xs text-ink-500">路段步行</span></div>
          <div className="rounded-lg bg-paper p-3"><strong className="block text-lg">{head.itinerary.totalMinutes} 分钟</strong><span className="text-xs text-ink-500">含模拟停留与余量</span></div>
          <div className="rounded-lg bg-paper p-3"><strong className="block text-lg">{head.itinerary.stops.length} 站</strong><span className="text-xs text-ink-500">当前安排</span></div>
        </div>
        {head.suspended ? <p className="text-sm text-amber-800">此版已挂起：{head.suspended.reason}</p> : null}
        <TripRouteMap key={head.contentHash} itinerary={head.itinerary} />
        <ol className="space-y-3">{head.itinerary.stops.map((stop, i) => <li key={stopIdOf(stop)} className="rounded-lg border border-line p-3">
          <p className="font-medium">{i + 1}. {stop.name}</p><p className="mt-1 text-xs text-ink-500">{head.itinerary.legs[i].fromName} → {stop.name}：{head.itinerary.legs[i].distanceMeters} 米／{head.itinerary.legs[i].durationMinutes} 分钟</p>
          <p className="mt-1 text-xs text-ink-500">{stop.flyaiId === null ? "攻略来源，高德已核验，未关联飞猪数据" : "已关联飞猪信息，高德提供身份与路段"}；停留 {stop.stayMinutes} 分钟为模拟值。</p>
        </li>)}</ol>
        {head.diff ? <div className="rounded-lg bg-paper p-4 text-sm leading-7">{head.diff.lines.map((line, i) => <p key={i}>{line}</p>)}</div> : null}
        <p className="text-sm leading-7 text-ink-500">{head.solve.note}</p>
        {head.solve.unmet.map((hit, i) => <p key={i} className="text-sm text-amber-800">{hit.role}：{hit.text}</p>)}
        <button disabled={busy || !!head.suspended} onClick={() => void act("explain")} className="rounded-lg border border-brand-700 px-4 py-2 text-sm text-brand-700">请 AI 解释这一版的取舍</button>
        {explanation ? <div className="space-y-2 rounded-lg bg-paper p-4 text-sm leading-7"><p className="text-xs text-ink-500">百炼基于本版核验结果与攻略观点解释</p><h4 className="font-medium">{explanation.headline}</h4>{explanation.details.map((line, index) => <p key={index}>{line}</p>)}<p>{explanation.next}</p>{explanation.notice ? <p className="text-amber-800">{explanation.notice}</p> : null}{explanation.sources.length ? <p className="text-xs text-ink-500">参考资料：{explanation.sources.map((s) => s.title).join("、")}。攻略观点不替代真实路段或个人决定。</p> : null}</div> : null}
        <details className="text-sm"><summary className="cursor-pointer text-brand-700">查看未入选原因</summary>{head.solve.dispositions.map((d) => <p key={d.id} className="mt-2 leading-6">{d.name}：{d.text}</p>)}</details>
        <div className="rounded-lg border border-line p-4 text-sm"><p>发起人：{head.confirmations.A ? "已确认此版" : "待确认"}{trip.members.B ? "；搭子：" + (head.confirmations.B ? "已确认此版" : "待确认") : "；搭子尚未加入"}</p></div>
        <button disabled={busy || !!head.suspended} onClick={() => void act("confirm", { revision: head.revision, contentHash: head.contentHash })} className="rounded-lg bg-brand-700 px-5 py-3 text-white disabled:opacity-50">我确认 v{head.revision} 的具体安排</button>
        <p className="text-xs leading-6 text-ink-500">只确认这一版。路线或个人条件更新后需要重新审阅；资料观点不构成门票价格、景区内部步行或开放时间保证。</p>
      </section> : <p className="rounded-xl border border-dashed border-line p-6 text-sm text-ink-500">先挑选地点、提交自己的条件，再查看报价并核验路线。</p>}
    </div> : null}
    <section className="space-y-4 rounded-xl border border-line bg-white p-5">
      <h2 className="text-lg font-semibold">问问这些攻略</h2>
      <p className="text-sm text-ink-500">从当前旅行的资料找依据；这里不会自动查询飞猪或高德。</p>
      <form onSubmit={async (e) => { e.preventDefault(); if (await act("ask", { question })) setShowAnswer(true); }} className="flex gap-2">
        <input required maxLength={1000} aria-label="向旅行资料提问" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="有没有安静、适合拍照的地方？" className="min-w-0 flex-1 rounded-lg border border-line p-3" />
        <button disabled={busy} className="rounded-lg bg-brand-700 px-4 py-2 text-sm text-white disabled:opacity-50">查资料</button>
      </form>
      {showAnswer && answer && answer.knowledgeVersion === trip.knowledgeVersion && answer.routeRevision === (trip.plan?.headRevision ?? null) ? <div className="space-y-3">
        <p className="whitespace-pre-wrap text-sm leading-7">{answer.answer}</p>
        {answer.notice ? <p className="text-xs text-amber-800">{answer.notice}</p> : null}
        {answer.citations.map((citation) => <details key={citation.chunkId} className="rounded-lg bg-paper p-3 text-sm">
          <summary className="cursor-pointer text-brand-700">依据：《{citation.title}》第 {citation.ordinal + 1} 段 · {citation.owner === "A" ? "发起人" : "搭子"}提供</summary>
          <p className="mt-3 whitespace-pre-wrap leading-7">{citation.text}</p>
          {citation.image ? <PrivateImage tripId={tripId} materialId={citation.materialId} credential={workspace.credential!} /> : null}
        </details>)}
      </div> : showAnswer && answer ? <p className="text-sm text-ink-500">资料或路线已更新，请重新提问以获取当前依据。</p> : null}
    </section>
    <JobFailures snapshot={snapshot} busy={busy} act={act} />
    <footer className="pb-6 text-xs text-ink-500">资料与协商记录保留至 {new Date(trip.expiresAt).toLocaleDateString("zh-CN")}。路线事实按原始测量时间单独判断有效期。</footer>
  </main>;
}
function JobFailures({ snapshot, busy, act }: { snapshot: TripSnapshot; busy: boolean; act: ReturnType<typeof useTripWorkspace>["act"] }) {
  const failures = snapshot.jobs.filter((j) => j.status === "failed" && !snapshot.jobs.some((newer) => newer.kind === j.kind && newer.status === "ready" && newer.createdAt > j.createdAt && (j.kind !== "material" || newer.input.materialId === j.input.materialId)));
  if (!failures.length) return null;
  return <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
    <h2 className="text-sm font-semibold">有任务需要处理</h2>
    {failures.map((job) => <div key={job.id} className="text-sm leading-6"><p>{job.error}</p>{job.owner === snapshot.role ? <button disabled={busy} onClick={() => void act("jobs/" + job.id)} className="mt-1 text-brand-700 underline">确认后重试此任务</button> : null}</div>)}
  </section>;
}
function choiceOf(party: PartyConditions | null, id: string): string {
  if (!party) return "尚未提交条件";
  if (party.hard.mustVisit.includes(id)) return "必须去";
  if (party.hard.neverAccept.includes(id)) return "绝不接受";
  const rank = party.soft[id];
  return rank ? ({ prefer: "特别想去", ok: "可以去", avoid: "不太想去", follow: "愿意跟随" })[rank] : "尚未逐站评价";
}
