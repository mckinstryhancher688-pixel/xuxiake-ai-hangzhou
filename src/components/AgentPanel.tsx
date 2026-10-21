"use client";

import type { AgentController, LiveTurn } from "@/hooks/useAgent";
import { AGENT_SOURCE_LABEL, ARRIVAL_MODE_LABEL } from "@/lib/agent";
import type { AdjustResponse, AgentNarration, ExploreResponse } from "@/lib/types";

const PHASE_BADGE = {
  idle: { label: "未调用", className: "bg-paper text-ink-300 ring-1 ring-line" },
  loading: { label: "调用中…", className: "bg-accent-500/15 text-accent-600" },
  done: { label: "LIVE · 百炼真实返回", className: "bg-brand-600/15 text-brand-700" },
} as const;

export function AgentPanel({
  agent,
  stops,
}: {
  agent: AgentController;
  stops: { flyaiId: string; name: string; matchStatus: string }[];
}) {
  const loading = agent.arrived.phase === "loading" || agent.adjusted.phase === "loading";

  return (
    <section className="rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">在场探索 · 百炼托管智能体</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            服务端把飞猪与高德已经核实过的结构化数据交给百炼 Managed Agent，智能体只负责讲解与删站建议；
            它报出的每一个数字都会和高德实测值对账。
          </p>
        </div>
        <span className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-medium ${badge(agent).className}`}>
          {badge(agent).label}
        </span>
      </div>

      {stops.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-line bg-paper px-3 py-2.5 text-[11px] leading-relaxed text-ink-300">
          这一层需要「已核实行程」才能工作。请先在上方点「校验真实路线」拿到飞猪＋高德的核验结果；
          没有核实数据时本面板不会调用百炼，也不会用演示文案冒充成功。
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {stops.map((stop, index) => {
              const active = stop.flyaiId === agent.selectedStopId;
              return (
                <button
                  key={stop.flyaiId}
                  type="button"
                  onClick={() => agent.selectStop(stop.flyaiId)}
                  disabled={loading}
                  aria-pressed={active}
                  className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium ring-1 transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    active
                      ? "bg-brand-700 text-white ring-brand-700"
                      : "bg-paper text-ink-500 ring-line hover:bg-white"
                  }`}
                >
                  {index + 1}. {stop.name}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void agent.arrive()}
              disabled={loading}
              className="rounded-lg bg-accent-500 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {agent.arrived.phase === "loading" ? "百炼生成中…" : "我到了"}
            </button>
            <button
              type="button"
              onClick={() => void agent.shorten()}
              disabled={loading}
              className="rounded-lg bg-brand-700 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {agent.adjusted.phase === "loading" ? "调整校验中…" : "少走一点"}
            </button>
            <span className="text-[10px] leading-relaxed text-ink-300">
              每点一次就是一次真实的百炼回合；同一个页面里连续点击会延续同一段对话，所以「少走一点」知道上文。
            </span>
          </div>
        </>
      )}

      {agent.arrival || agent.arrived.phase === "loading" ? (
        <ArrivalResult
          response={agent.arrival}
          error={agent.arrived.error}
          loading={agent.arrived.phase === "loading"}
          live={agent.live.arrive}
          canRetry={agent.canRetryArrive}
          onRetry={agent.arrive}
        />
      ) : (
        agent.arrived.phase === "done" &&
        agent.arrived.error && (
          <Failure
            text={agent.arrived.error}
            label="百炼调用失败"
            canRetry={agent.canRetryArrive}
            onRetry={agent.arrive}
          />
        )
      )}

      {agent.adjustment || agent.adjusted.phase === "loading" ? (
        <AdjustResult
          response={agent.adjustment}
          error={agent.adjusted.error}
          loading={agent.adjusted.phase === "loading"}
          live={agent.live.shorten}
          canRetry={agent.canRetryShorten}
          onRetry={agent.shorten}
        />
      ) : (
        agent.adjusted.phase === "done" &&
        agent.adjusted.error && (
          <Failure
            text={agent.adjusted.error}
            label="调整失败"
            canRetry={agent.canRetryShorten}
            onRetry={agent.shorten}
          />
        )
      )}
    </section>
  );
}

function badge(agent: AgentController) {
  const phases = [agent.arrived.phase, agent.adjusted.phase];
  if (phases.includes("loading")) return PHASE_BADGE.loading;
  const anyDone = phases.includes("done");
  const anyOk = agent.arrival?.ok || agent.adjustment?.ok;
  if (anyDone && !anyOk) {
    return { label: "调用失败", className: "bg-red-500/10 text-red-600" };
  }
  if (anyDone && anyOk) return PHASE_BADGE.done;
  return PHASE_BADGE.idle;
}

/* ── 我到了的结果 ───────────────────────────────────────────────── */

function ArrivalResult({
  response,
  error,
  loading,
  live,
  canRetry,
  onRetry,
}: {
  response: ExploreResponse | null;
  error: string | null;
  loading: boolean;
  live: LiveTurn;
  canRetry: boolean;
  onRetry: () => Promise<void>;
}) {
  return (
    <div className="mt-4 border-t border-line pt-3">
      <SectionTitle>「我到了」在场讲解</SectionTitle>
      {loading && <LiveProgress live={live} label="百炼" />}
      {!loading && !response?.ok && (
        <Failure
          text={error ?? response?.error ?? "百炼没有返回可用结果。"}
          label="失败"
          canRetry={canRetry}
          onRetry={onRetry}
        />
      )}
      {response?.ok && response.narration && (
        <Narration narration={response.narration} stopName={response.stopName ?? ""} />
      )}
    </div>
  );
}

function Narration({ narration, stopName }: { narration: AgentNarration; stopName: string }) {
  return (
    <div className="mt-2 rounded-xl border border-brand-100 bg-brand-50/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-brand-700 px-1.5 py-0.5 text-[10px] font-medium text-white">
          百炼 · 千问
        </span>
        <span className="text-[10px] text-brand-700">{AGENT_SOURCE_LABEL}</span>
      </div>
      <p className="mt-1 text-[10px] text-ink-300">
        针对「{stopName}」· {ARRIVAL_MODE_LABEL}
      </p>

      {narration.degraded && (
        <p className="mt-2 rounded-lg bg-accent-500/10 px-2.5 py-1.5 text-[10px] leading-relaxed text-accent-700">
          智能体没有按约定的 JSON 格式返回，下面直接展示原文，未经结构化整理。
        </p>
      )}

      <h3 className="mt-2 text-sm font-semibold text-ink-900">{narration.headline}</h3>

      {narration.details.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {narration.details.map((item) => (
            <li key={item} className="flex gap-2 text-xs leading-relaxed text-ink-700">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-brand-500" />
              {item}
            </li>
          ))}
        </ul>
      )}

      {narration.nextSuggestion && (
        <p className="mt-3 rounded-lg bg-white/70 px-2.5 py-2 text-[11px] leading-relaxed text-ink-700">
          <span className="font-medium text-brand-700">下一步 · </span>
          {narration.nextSuggestion}
        </p>
      )}

      <NumericAudit narration={narration} />
    </div>
  );
}

/**
 * 数字对账：把回复里出现的「米 / 分钟」逐个与服务端实测值比对。
 * 合计类数字也会落进未匹配，所以这里给的是核查线索，不是自动判罪。
 */
function NumericAudit({ narration }: { narration: AgentNarration }) {
  const audit = narration.numericAudit;
  if (audit.claims.length === 0) {
    return (
      <p className="mt-2 text-[10px] leading-relaxed text-ink-300">
        数字对账：这段回复没有出现任何米／分钟数字，无需与高德实测值核对。
      </p>
    );
  }
  const allMatched = audit.unmatched.length === 0;
  return (
    <p
      className={`mt-2 text-[10px] leading-relaxed ${allMatched ? "text-ink-300" : "text-accent-700"}`}
    >
      数字对账：回复中 {audit.claims.length} 处米／分钟，其中 {audit.matched} 处与高德实测值完全一致
      {allMatched
        ? "。"
        : `；未匹配的 ${audit.unmatched.join("、")} 需要人工确认（智能体把几段相加得到的合计也会算未匹配）。`}
    </p>
  );
}

/* ── 少走一点的结果 ─────────────────────────────────────────────── */

function AdjustResult({
  response,
  error,
  loading,
  live,
  canRetry,
  onRetry,
}: {
  response: AdjustResponse | null;
  error: string | null;
  loading: boolean;
  live: LiveTurn;
  canRetry: boolean;
  onRetry: () => Promise<void>;
}) {
  return (
    <div className="mt-4 border-t border-line pt-3">
      <SectionTitle>「少走一点」动态调整</SectionTitle>
      {loading && <LiveProgress live={live} label="智能体正在给方案，服务端随后用高德逐段实测" />}

      {response?.proposedNames.length ? (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
          智能体提议只保留：{response.proposedNames.join(" → ")}
          {response.agentReason ? `（${response.agentReason}）` : ""}
        </p>
      ) : null}

      {response?.droppedNames.length ? (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
          本次少走的后续地点：{response.droppedNames.join("、")}
        </p>
      ) : null}

      {response?.firstAttemptFailure && (
        <p className="mt-1 rounded-lg bg-accent-500/10 px-2.5 py-1.5 text-[10px] leading-relaxed text-accent-700">
          第一个方案未通过校验：{response.firstAttemptFailure} 已把这句原样回灌给智能体并重问一次。
        </p>
      )}

      {response && !response.ok && (
        <Failure
          text={
            error ??
            response.error ??
            response.validationError ??
            "调整后的方案没有通过服务端校验。"
          }
          label="未采用"
          canRetry={canRetry}
          onRetry={onRetry}
        />
      )}

      {/* 通过校验的路线只有一份：上图 + 上方核验面板，这里不再重复渲染一遍 */}
      {response?.ok && response.itinerary && (
        <p className="mt-2 rounded-xl border border-brand-100 bg-brand-50/60 px-3 py-2 text-[11px] leading-relaxed text-ink-700">
          这份方案已经过服务端逐段高德实测校验，共 {response.itinerary.stops.length} 站 /{" "}
          {response.itinerary.totalMinutes} 分钟，现在就是上方「高德核验路线」与左侧地图里显示的那一条。
          本次校验新发起高德步行实测 {response.amapNewCalls} 次（0 表示全部命中服务端缓存，没有额外消耗配额）。
        </p>
      )}

      {response?.ok && (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
          {response.unverifiedNotes.length === 0
            ? "未核实事项：无，后续各站的坐标核对与开放时间都没有异常。"
            : `未核实事项：${response.unverifiedNotes.join("；")}。`}
        </p>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-medium tracking-wide text-ink-300">{children}</h3>;
}

/** 真实进度：等了多少秒、流式收到了多少字，出字后原样滚出来。 */
function LiveProgress({ live, label }: { live: LiveTurn; label: string }) {
  const chars = live.text.length;
  return (
    <div className="mt-2 rounded-xl border border-dashed border-brand-100 bg-brand-50/40 px-3 py-2">
      <p className="flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
        <span className="size-2.5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
        {label} · 已等 {(live.waitedMs / 1000).toFixed(1)} 秒 ·{" "}
        {chars === 0 ? "百炼这一轮还没开始出字" : `已流式收到 ${chars} 字`}
      </p>
      {chars > 0 && (
        <>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-300">
            以下是智能体正在生成的原始文字，未经服务端校验，不作为结论；校验通过的结果会在下方单独给出。
          </p>
          <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-white/70 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-500">
            {live.text}
          </pre>
        </>
      )}
    </div>
  );
}

/**
 * 失败原文照实展示，不粉饰；重试只在失败态出现，且必须由用户主动点击。
 * 一个回合＝一次付费调用，所以这里不用自动重试，也不在按钮上叠加并发。
 */
function Failure({
  text,
  label,
  canRetry,
  onRetry,
}: {
  text: string;
  label: string;
  canRetry?: boolean;
  onRetry?: () => Promise<void>;
}) {
  return (
    <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700">
      <p>
        <span className="font-medium">{label} · </span>
        {text}
      </p>
      {canRetry && onRetry && (
        <>
          <button
            type="button"
            onClick={() => void onRetry()}
            className="mt-2 rounded-lg bg-red-600 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-red-500"
          >
            重试这一步
          </button>
          <p className="mt-1.5 text-[10px] leading-relaxed text-red-600/80">
            重试会重新发起一个百炼回合；刚才那次没有成功，所以既没有标记到达，也没有改动路线，
            再点一次不会把同一步走两遍。
          </p>
        </>
      )}
    </div>
  );
}
