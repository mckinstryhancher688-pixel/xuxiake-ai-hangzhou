"use client";

import { useState } from "react";
import { DEFAULT_QUESTION, UNDERSTAND_MAX_CHARS, type Understanding } from "@/lib/understand";
import { WALK_MINUTE_OPTIONS, WALK_MINUTES_BASIS, minutesLabel } from "@/lib/walk-minutes";

/**
 * 首页唯一的那一问：爸妈全程一共能走多久。
 *
 * 两种回答方式：点固定选项，或者用一句话说说爸妈的情况。
 * 说了一句话之后：
 * - 话里有确定的全程时长 → 代码算出分钟数，高亮对应选项，并把原话复述出来；
 * - 话里只有身体情况、一口气走多久、或含糊时长 → 标题换成模型写的追问，选项不变，让用户点；
 * - 没读成 → 如实说原因，退回默认问题。
 * 数字只来自用户的点选或用户原话，见 lib/understand.ts。
 */

export const UNDERSTAND_ENDPOINT = "/api/understand";

interface UnderstandResponse {
  ok: true;
  understanding: Understanding;
  degraded: boolean;
  error: string | null;
  cost: { modelCalls: number };
}

export function PreflightQuestion({
  minutes,
  onChange,
  disabled = false,
}: {
  /** undefined = 还没回答；null = 不确定（不设上限）；数字 = 分钟 */
  minutes: number | null | undefined;
  onChange: (minutes: number | null) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<UnderstandResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const question = reply?.understanding.question ?? DEFAULT_QUESTION;
  const isCustom = typeof minutes === "number" && !WALK_MINUTE_OPTIONS.some((option) => option.minutes === minutes);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(UNDERSTAND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: value }),
      });
      const body = (await response.json()) as UnderstandResponse | { error?: string };
      if (!response.ok || !("ok" in body)) {
        setError(("error" in body && body.error) || `没读成（HTTP ${response.status}），请直接选一个。`);
        setReply(null);
        return;
      }
      setReply(body);
      if (body.understanding.kind === "minutes") onChange(body.understanding.minutes);
    } catch (caught) {
      setError(`没读成（${caught instanceof Error ? caught.message : "网络错误"}），请直接选一个。`);
      setReply(null);
    } finally {
      setBusy(false);
    }
  };

  const chip = (key: string, label: string, sub: string | undefined, selected: boolean, onClick?: () => void) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex min-w-[64px] flex-1 flex-col rounded-lg border px-2 py-1.5 text-left transition ${
        selected ? "border-brand-600 bg-brand-600/10 text-brand-700" : "border-line bg-card text-ink-700"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <span className="text-[11px] font-semibold">{label}</span>
      {sub && <span className="text-[9.5px] text-ink-500">{sub}</span>}
    </button>
  );

  const understanding = reply?.understanding ?? null;
  const notes = [
    understanding?.note ?? null,
    understanding?.other.length ? `${understanding.other.map((item) => `「${item}」`).join("、")}这一版还用不上。` : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <div className="mb-2.5 rounded-xl border border-line bg-paper px-2.5 py-2" aria-label="爸妈全程能走多久">
      <p className="text-[11px] font-semibold text-ink-700" data-testid="preflight-question">
        {question}
        {reply?.understanding.questionFromModel && (
          <span className="ml-1 text-[10px] font-normal text-ink-400">（按您说的情况追问）</span>
        )}
      </p>
      <p className="mt-0.5 text-[10px] leading-relaxed text-ink-500">
        先定这条线，生成时就直接按它排。{WALK_MINUTES_BASIS}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {WALK_MINUTE_OPTIONS.map((option) =>
          chip(option.label, option.label, option.sub, minutes !== undefined && minutes === option.minutes, () => onChange(option.minutes)),
        )}
        {isCustom && typeof minutes === "number" && chip("custom", minutesLabel(minutes), "您说的", true)}
      </div>
      <form
        className="mt-1.5 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          type="text"
          value={text}
          maxLength={UNDERSTAND_MAX_CHARS}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled || busy}
          placeholder="也可以直接说，比如：我妈膝盖不好"
          aria-label="说说爸妈的情况"
          className="min-w-0 flex-1 rounded-lg border border-line bg-card px-2 py-1.5 text-[11px] text-ink-700 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none"
        />
        <button
          type="submit"
          disabled={disabled || busy || !text.trim()}
          className="shrink-0 rounded-lg border border-brand-600 px-2.5 py-1.5 text-[11px] font-medium text-brand-700 disabled:opacity-40"
        >
          {busy ? "正在读…" : "读一下"}
        </button>
      </form>
      {error && <p className="mt-1 text-[10.5px] leading-relaxed text-red-600" role="status">{error}</p>}
      {reply && (
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink-600" role="status" data-testid="preflight-note">
          {notes.join(" ")}
          {/* 每读一句话都是一次真实的模型调用，如实写出来 */}
          <span className="text-ink-400">{notes.length ? " " : ""}（调用百炼 {reply.cost.modelCalls} 次）</span>
        </p>
      )}
    </div>
  );
}
