"use client";

import { useState } from "react";
import { COST_SCOPE_NOTICE, type PartyConditions } from "@/lib/negotiation/types";
import { conditionsFromDraft, costApprovalKey, draftFromConditions, savedConditionsKey, type ConditionsDraft, type PoiChoice } from "@/lib/negotiation/editor";
import { MATCH_STATUS_LABELS, OPENING_STATUS_LABELS } from "@/lib/verification";
import type { PlanController } from "@/hooks/usePlan";
import type { RevisionView } from "@/lib/plan-api";
import type { NegotiationExplainResponse } from "@/lib/types";

const RANK_LABELS: Record<string, string> = {
  must: "必须去（硬条件）",
  never: "绝不接受（硬条件）",
  prefer: "特别想去",
  ok: "可以去",
  avoid: "不太想去",
  follow: "愿意跟随",
};

function DiffCard({ revision }: { revision: RevisionView }) {
  const diff = revision.diff;
  return (
    <div className="rounded-lg border border-line bg-paper p-3 text-xs">
      <p className="font-medium">
        v{revision.revision} · {revision.kind === "proposal" ? "提案（不改条件）" : "条件更新后的新方案"} ·{" "}
        {revision.status === "jointly-confirmed" ? "双方已确认" : revision.status === "superseded" ? "已被新版本取代" : "等待双方确认"}
      </p>
      {diff ? (
        <ul className="mt-2 space-y-1">
          {diff.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-ink-500">这是第一版，没有可对比的上一版。</p>
      )}
      <p className="mt-2 text-ink-500">
        站点：{revision.itinerary.stops.map((stop) => stop.name).join(" → ") || "（无）"} · 总步行{" "}
        {revision.itinerary.totalWalkMeters} 米 / 步行 {revision.itinerary.totalWalkMinutes} 分钟 · 总时长{" "}
        {revision.itinerary.totalMinutes} 分钟（预算 {revision.itinerary.budgetMinutes} 分钟）
      </p>
      <p className="mt-1 text-ink-500">每一段数字都来自这一版的高德实测段，不含任何硬编码答案。</p>
    </div>
  );
}

/**
 * 「让 AI 解释这次取舍」。
 *
 * 这一步买一个真实百炼回合，只在显式点击时发起；解释读的是服务端已经算好的事实块。
 * 失败时把服务端原话贴出来，上方规则求解结果继续有效——不拿固定文案冒充 AI 返回。
 */
function ExplainCard({
  explanation,
  explaining,
  headRevision,
  onExplain,
  blockedReason,
}: {
  explanation: NegotiationExplainResponse | null;
  explaining: boolean;
  headRevision: number | null;
  onExplain: () => void;
  blockedReason: string | null;
}) {
  const stale = explanation !== null && explanation.revision !== null && explanation.revision !== headRevision;
  const unmatched = explanation?.audit?.unmatched ?? [];
  return (
    <div className="mt-3 rounded-lg border border-line bg-paper p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">让 AI 解释这次取舍</p>
        <button
          type="button"
          disabled={explaining || headRevision === null || blockedReason !== null}
          onClick={onExplain}
          className="rounded-lg border border-brand-500/40 bg-brand-50 px-3 py-1.5 font-medium text-brand-700 disabled:opacity-50"
        >
          {explaining ? "百炼正在生成…" : `解释 v${headRevision ?? "—"}`}
        </button>
      </div>
      <p className="mt-1 leading-5 text-ink-500">
        这一步会真实调用一次百炼。距离、耗时、可行性与硬约束是否满足都由服务端判定，模型只解释取舍、
        并只能在服务端给出的下一步选项里挑；它不能改任何人的底线，也不能替对方同意。
      </p>
      {blockedReason ? <p className="mt-2 text-amber-800">{blockedReason}</p> : null}
      {stale ? (
        <p className="mt-2 rounded bg-amber-50 p-2 text-amber-900">
          这份解释针对的是 v{explanation?.revision}，当前已是 v{headRevision}，请重新解释。
        </p>
      ) : null}
      {!explanation ? null : !explanation.ok ? (
        <p className="mt-2 rounded border border-rose-300 bg-rose-50 p-2 leading-5 text-rose-800">
          AI 解释失败：{explanation.error ?? "服务端没有给出原因。"}
          （上方规则求解结果仍是服务端的结论，没有被这段失败替换。）
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
              LIVE · 百炼真实返回
            </span>
            {explanation.proof ? (
              <span className="text-[10px] text-ink-500">
                {explanation.proof.modelTurns} 个模型回合 · {(explanation.proof.durationMs / 1000).toFixed(1)} 秒 ·{" "}
                {explanation.proof.usage.inputTokens} 入 / {explanation.proof.usage.outputTokens} 出 token
                {explanation.proof.resolvedModels.length ? ` · ${explanation.proof.resolvedModels.join("/")}` : ""}
              </span>
            ) : null}
          </div>
          {explanation.summary ? <p className="leading-5">{explanation.summary}</p> : null}
          {explanation.points.length ? (
            <ul className="list-disc space-y-0.5 pl-4 leading-5">
              {explanation.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          ) : null}
          {explanation.nextSteps.length ? (
            <ul className="space-y-1">
              {explanation.nextSteps.map((step) => (
                <li key={step.key} className="leading-5">
                  <span className="font-medium">{step.text}</span>
                  {step.extraCalls !== null ? (
                    <span className="text-ink-500">
                      {step.extraCalls === 0 ? "（已实测段内就能重排，不新增调用）" : `（需新增 ${step.extraCalls} 次高德实测）`}
                    </span>
                  ) : null}
                  {step.why ? <span className="text-ink-500"> · {step.why}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {explanation.cautions.length ? (
            <p className="leading-5 text-ink-500">需要注意：{explanation.cautions.join("；")}</p>
          ) : null}
          {unmatched.length ? (
            <p className="rounded bg-amber-50 p-2 leading-5 text-amber-900">
              数字对账：模型写了不在服务端事实里的数字，已标出、不作结论 —— {unmatched.join("、")}
            </p>
          ) : null}
          {explanation.rejectedKeys.length ? (
            <p className="leading-5 text-ink-500">
              模型还提了服务端没有的动作，已丢弃：{explanation.rejectedKeys.join("、")}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function NegotiationPanel({ plan, factsId }: { plan: PlanController; factsId: string | null }) {
  const {
    identity,
    snapshot,
    result,
    error,
    busy,
    explanation,
    explaining,
    create,
    submitConditions,
    confirm,
    revoke,
    leave,
    explain,
  } = plan;
  const [edit, setEdit] = useState<{
    owner: string;
    savedKey: string;
    revision: number | null;
    draft: ConditionsDraft;
  } | null>(null);
  const [costQuote, setCostQuote] = useState<{ context: string; mine: string } | null>(null);

  const head = snapshot?.head ?? null;
  const gate = busy
    ? { allowed: false, reason: "正在更新协商状态，结果返回前暂停执行。" }
    : plan.syncError ? { allowed: false, reason: plan.syncError } : snapshot?.canExecute ?? null;

  if (!identity) {
    return (
      <section className="rounded-xl border border-line bg-card p-4">
        <h2 className="text-sm font-semibold">双人协商</h2>
        <p className="mt-1 text-xs leading-5 text-ink-500">
          两个人先去过的地方、能走多远、哪些绝不接受，往往互相不知道。这里让双方各自表态，
          再由服务端用同一批高德实测数据反复重解，直到两个人确认同一版本为止。
        </p>
        <button
          type="button"
          disabled={!factsId || busy}
          onClick={() => void create(factsId ?? "")}
          className="mt-3 w-full rounded-lg bg-brand-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          {!factsId ? "先点「生成我的路线」，再发起双人协商" : busy ? "正在建立协商…" : "发起双人协商（复用已实测数据，不新增高德调用）"}
        </button>
        {error ? <p className="mt-2 text-xs text-rose-700">{error}</p> : null}
      </section>
    );
  }

  const role = snapshot?.role ?? identity.role;
  const mine = snapshot ? snapshot.conditions[role] : null;
  const owner = `${identity.planId}:${role}`;
  const savedKey = savedConditionsKey(mine);
  const activeEdit = edit?.owner === owner ? edit : null;
  // 没有编辑时直接从完整已保存条件派生；同伴刷新不会覆盖正在填写的本方草稿。
  const draft = activeEdit?.draft ?? draftFromConditions(mine);
  const ownConditionsChanged = activeEdit !== null && activeEdit.savedKey !== savedKey;
  const peerRevisionChanged = activeEdit !== null && activeEdit.revision !== (snapshot?.headRevision ?? null);
  const submittedConditions = { role, ...conditionsFromDraft(draft) };
  const quoteValid = costQuote !== null && snapshot?.status === "awaiting-cost-approval"
    && costQuote.context === costApprovalKey(identity.planId, role, snapshot.headRevision, snapshot.conditions)
    && costQuote.mine === savedConditionsKey(submittedConditions);
  const editDraft = (change: Partial<ConditionsDraft>) => {
    setCostQuote(null);
    setEdit({
      owner,
      savedKey: activeEdit?.savedKey ?? savedKey,
      revision: activeEdit ? activeEdit.revision : snapshot?.headRevision ?? null,
      draft: { ...draft, ...change },
    });
  };
  const submitDraft = async (confirmCost: boolean) => {
    if (ownConditionsChanged || !snapshot || busy || (confirmCost && !quoteValid)) return;
    setCostQuote(null);
    const view = await submitConditions(conditionsFromDraft(draft), confirmCost, confirmCost ? costQuote?.context : undefined);
    if (view?.code === "cost-approval-needed") {
      setCostQuote({
        context: costApprovalKey(identity.planId, role, snapshot.headRevision, { ...snapshot.conditions, [role]: submittedConditions }),
        mine: savedConditionsKey(submittedConditions),
      });
    }
    // 下列结果的条件已经保存，即使求解无解也不能恢复旧底线。冲突/网络失败则保留编辑。
    if (view && ["ok", "cost-approval-needed", "no-solution", "measurement-failed", "quota"].includes(view.code)) {
      setEdit(null);
    }
  };
  const peerConfirmed = head ? head.confirmations[role === "A" ? "B" : "A"] : null;
  const iConfirmed = head ? head.confirmations[role] : null;

  return (
    <section className="rounded-xl border border-line bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">双人协商 · 你是 {role}</h2>
        <button type="button" onClick={leave} className="text-xs text-ink-500 underline">
          退出这条协商
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-500">
        <span>双方状态自动同步；条件修改后需分别确认新版。</span>
        <button type="button" disabled={busy || plan.refreshing} onClick={() => void plan.refresh()} className="shrink-0 underline disabled:opacity-50">
          {plan.refreshing ? "正在同步…" : "刷新协商状态"}
        </button>
      </div>
      {plan.updateNotice ? <p role="status" className="mt-1 text-xs text-brand-700">{plan.updateNotice}</p> : null}

      <p className="mt-1 text-xs leading-5 text-ink-500">
        链接是访问凭据，不是身份证明：拿到 {role} 这条链接的人，就等于这一方。
        {identity.links ? " 另一条链接请交给同伴。" : ""}
      </p>
      {identity.links ? (
        <div className="mt-2 space-y-1 text-xs">
          {(["A", "B"] as const).map((role) => (
            <label key={role} className="block">
              <span className="text-ink-500">{role === "A" ? "发起方（你）" : "同伴那一份"}</span>
              <input
                readOnly
                value={identity.links?.[role]}
                onFocus={(event) => event.currentTarget.select()}
                className="mt-1 w-full rounded border border-line bg-paper px-2 py-1 font-mono text-[11px]"
              />
            </label>
          ))}
        </div>
      ) : null}

      {/* 执行门禁：只在双方确认同一版本后放行 */}
      <div className={`mt-3 rounded-lg border p-3 text-xs ${gate?.allowed ? "border-emerald-300 bg-emerald-50" : "border-line bg-paper"}`}>
        <p className="font-medium">{gate?.allowed ? `正式执行：v${snapshot?.officialRevision} 已由双方确认` : "还不能正式执行"}</p>
        <p className="mt-1 text-ink-500">{gate?.reason}</p>
        {gate?.allowed ? (
          <p className="mt-1 text-ink-500">
            地图与行程面板已经切到 v{snapshot?.officialRevision}，走的就是这一份双方确认的路线；
            折线仍来自这一版的高德实测段，没有退回更早的城市/类别结果。
          </p>
        ) : null}
      </div>

      {head ? (
        <>
          <div className="mt-3 space-y-2">
            {head.outcome === "hard-conflict" ? (
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs">
                需要双方协商（硬约束互相矛盾，不会替谁放宽条件）：{head.hardConflict?.evidence.join("；")}
              </p>
            ) : null}
            {head.outcome === "not-measured" ? (
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs">
                尚未核验：{head.note.slice(0, 160)}…（补测需要 {head.extraLegsNeeded} 次高德实测）
              </p>
            ) : null}
            {head.outcome === "soft-imbalanced" ? (
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs">
                方案可行，但一方的「特别想去」全部落空——需要双方再谈一轮（这不是硬约束冲突）。
              </p>
            ) : null}
            <DiffCard revision={head} />
          </div>

          <ul className="mt-2 space-y-1 text-xs">
            {head.satisfied.filter((item) => item.role === role).slice(0, 6).map((item) => (
              <li key={`${item.role}-${item.text}`} className="text-emerald-800">✓ {item.text}</li>
            ))}
            {head.unmet.slice(0, 8).map((item) => (
              <li key={`${item.role}-${item.text}`} className="text-amber-800">△ [{item.role}] {item.text}</li>
            ))}
          </ul>
          {head.unverified.length ? (
            <p className="mt-1 text-xs text-ink-500">未核实事项：{head.unverified.join("；")}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || activeEdit !== null || snapshot?.status !== "awaiting-confirmation" || Boolean(iConfirmed)}
              onClick={() => head && void confirm(head.revision, head.contentHash)}
              className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
            >
              {iConfirmed ? `你已确认 v${head.revision}` : `确认 v${head.revision}`}
            </button>
            <button
              type="button"
              disabled={busy || !snapshot || !head}
              onClick={() => void plan.propose()}
              className="rounded-lg border border-brand-500/40 bg-brand-50 px-3 py-2 text-xs font-medium text-brand-700 disabled:opacity-50"
            >
              少走一点（只提提案，不改条件）
            </button>
            <p className="text-xs leading-7 text-ink-500">
              {peerConfirmed ? `对方已确认 v${head.revision}` : "等待对方确认同一版本"}
              {snapshot && snapshot.officialRevision !== null && snapshot.headRevision !== snapshot.officialRevision
                ? `（正在执行的仍是上一份确认版本 v${snapshot.officialRevision}）`
                : ""}
            </p>
          </div>
          {activeEdit ? <p className="mt-1 text-xs text-amber-800">请先提交或放弃未提交的条件修改，再确认这份方案。</p> : null}

          <ExplainCard
            explanation={explanation}
            explaining={explaining}
            headRevision={head.revision}
            onExplain={() => void explain()}
            blockedReason={busy || head.status === "superseded" || snapshot?.status === "paused" || snapshot?.status === "awaiting-cost-approval"
              ? "当前条件尚未求解完成，请先解决冲突或完成补测，再解释新版。"
              : null}
          />
        </>
      ) : (
        <p className="mt-3 text-xs text-ink-500">还没有版本。填好你这一方的条件后点「提交我的条件」。</p>
      )}

      {/* 条件录入：全部从已核验候选全集里点选，不做自由文本 */}
      <fieldset disabled={busy || !snapshot} className="mt-4 border-t border-line pt-3">
        <p className="text-xs font-medium">我这一方的条件</p>
        {ownConditionsChanged ? (
          <p role="status" className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
            本方已保存条件在另一页面发生变化。你的草稿仍保留，请先加载本方最新条件再编辑，避免覆盖底线。
            <button type="button" onClick={() => { setEdit(null); setCostQuote(null); }} className="ml-2 underline">加载本方最新条件</button>
          </p>
        ) : peerRevisionChanged ? (
          <p role="status" className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
            方案已更新，你的未提交条件已保留；请查看上方新版后再提交。
            <button type="button" onClick={() => { setEdit(null); setCostQuote(null); }} className="ml-2 underline">放弃未提交修改</button>
          </p>
        ) : activeEdit ? (
          <p className="mt-1 text-xs text-ink-500">
            有未提交的条件修改
            <button type="button" onClick={() => { setEdit(null); setCostQuote(null); }} className="ml-2 underline">放弃未提交修改</button>
          </p>
        ) : null}
        <div className="mt-2 space-y-1">
          <label className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 text-ink-500">步行上限</span>
            <input
              inputMode="numeric"
              value={draft.cap}
              onChange={(event) => editDraft({ cap: event.target.value.replace(/[^\d]/g, "").slice(0, 5) })}
              placeholder="米，留空＝不提这个要求"
              className="w-full rounded border border-line bg-paper px-2 py-1"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 text-ink-500">整体倾向</span>
            <select value={draft.bias} onChange={(event) => editDraft({ bias: event.target.value as PartyConditions["bias"] })} className="rounded border border-line bg-paper px-2 py-1">
              <option value="neutral">无所谓</option>
              <option value="see_more">多看几个</option>
              <option value="walk_less">少走路</option>
            </select>
          </label>
        </div>

        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
          {(snapshot?.pool ?? []).map((item) => (
            <li key={item.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate" title={`${item.name}（直线 ${item.straightLineMeters} 米）`}>
                {item.name}
                {item.matchStatus !== "matched" ? `·${MATCH_STATUS_LABELS[item.matchStatus]}` : ""}
                {item.openingStatus === "unknown" || item.openingStatus === "conflict"
                  ? `·开放时间${OPENING_STATUS_LABELS[item.openingStatus]}`
                  : ""}
              </span>
              <select
                aria-label={`${item.name}的出游意愿`}
                value={draft.choices[item.id] ?? "ok"}
                onChange={(event) => editDraft({ choices: { ...draft.choices, [item.id]: event.target.value as PoiChoice } })}
                className="shrink-0 rounded border border-line bg-paper px-1 py-1 text-[11px]"
              >
                {Object.entries(RANK_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>

        <button
          type="button"
          disabled={busy || !snapshot || ownConditionsChanged}
          onClick={() => void submitDraft(false)}
          className="mt-3 w-full rounded-lg bg-brand-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          {busy ? "服务端正在重解…" : "提交我的条件"}
        </button>
        <p className="mt-1 text-[11px] leading-4 text-ink-500">
          优先复用已实测数据；缺段时可能自动补测，超过 {snapshot?.budget.approvalThreshold ?? 6} 条会先询问。
          实际调用数见下方消耗记录。
        </p>
        {mine ? (
          <p className="mt-1 text-[11px] text-ink-500">
            当前生效：{mine.hard.maxWalkMeters ? `步行≤${mine.hard.maxWalkMeters} 米` : "未提步行上限"} ·{" "}
            {mine.hard.mustVisit.length ? `必须去 ${mine.hard.mustVisit.length} 处` : "无必须去"} ·{" "}
            {mine.hard.neverAccept.length ? `绝不接受 ${mine.hard.neverAccept.length} 处` : "无绝不接受"}
          </p>
        ) : null}
      </fieldset>

      {/* 成本闸门：只有这一步会真的花钱，且必须显式点击 */}
      {result?.code === "cost-approval-needed" ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs">
          {!quoteValid ? <p className="mb-2 font-medium">条件或方案已变化，原补测报价已失效。请先重新提交条件获取报价。</p> : null}
          <p className="font-medium">需要补测 {result.missingEdges.length} 条步行段才能回答这个条件</p>
          <ul className="mt-1 list-disc pl-4">
            {result.missingEdges.slice(0, 10).map((edge) => (
              <li key={edge.key}>{edge.name}</li>
            ))}
          </ul>
          <p className="mt-1 text-ink-500">本小时步行余量 {snapshot?.budget.hourlyHeadroomWalking} 次；批准后才会发起这些请求。</p>
          <button
            type="button"
            disabled={busy || ownConditionsChanged || !quoteValid}
            onClick={() => void submitDraft(true)}
            className="mt-2 w-full rounded-lg bg-amber-700 px-3 py-2 font-medium text-white disabled:opacity-50"
          >
            同意新增 {result.missingEdges.length} 次高德实测
          </button>
        </div>
      ) : null}
      {result && result.code !== "ok" && result.code !== "cost-approval-needed" ? (
        <p className="mt-2 rounded-lg border border-line bg-paper p-2 text-xs text-ink-500">
          {result.message}
        </p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-rose-700">{error}</p> : null}

      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-[11px] leading-4 text-ink-500">
          本次协商已消耗：逻辑请求 {snapshot?.budget.logicalRequests ?? 0} 次 · HTTP 重试 {snapshot?.budget.httpRetries ?? 0} 次 ·
          本方案累计 {snapshot?.budget.spentThisPlan ?? 0} / {snapshot?.budget.perPlanHardMax ?? 18} 次
        </p>
        {role === "A" ? (
          <button type="button" onClick={() => void revoke()} className="shrink-0 text-xs text-rose-700 underline">
            撤销这两条链接
          </button>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] leading-4 text-ink-500">{COST_SCOPE_NOTICE}</p>
    </section>
  );
}
