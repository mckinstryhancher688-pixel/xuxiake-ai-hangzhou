import { formatHangzhouShort } from "@/lib/hangzhou-time";
import { sourceEvidenceOf } from "@/lib/source-evidence";
import type { VerifiedStop } from "@/lib/types";

/**
 * 行程卡的证据条：来源 FlyAI · 查询时间 · ✓已校验。
 * ✓只有来源校验通过才点亮；时间未记录、校验未通过都如实写出，不用常识补。
 * 时间一律按杭州时间展示（口径在「数据可信说明」里声明）。
 */
export function EvidenceBar({ stop }: { stop: VerifiedStop }) {
  const evidence = sourceEvidenceOf(stop);
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[9px] leading-relaxed text-ink-300">
      <span className="rounded bg-brand-600/10 px-1 py-px font-medium text-brand-700">来源 FlyAI</span>
      <span>{evidence.collectedAt ? `查询于 ${formatHangzhouShort(evidence.collectedAt)}` : "查询时间未记录"}</span>
      {evidence.state === "checked" ? (
        <span className="rounded bg-brand-600/15 px-1 py-px font-medium text-brand-700">✓已校验</span>
      ) : (
        <span className="rounded bg-ink-300/25 px-1 py-px text-ink-500">未校验 · {evidence.reason}</span>
      )}
    </span>
  );
}