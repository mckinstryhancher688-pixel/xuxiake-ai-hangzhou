import type { JourneyContext } from "@/lib/types";
import { formatMinutes } from "@/lib/format";

/** 角标跟着当前数据来源变：核验前是演示数据，核验后必须说清真在哪里、假在哪里。 */
export function DataBadge({ verified, className = "" }: { verified: boolean; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        verified
          ? "border-brand-500/40 bg-brand-50 text-brand-700"
          : "border-accent-500/40 bg-accent-50 text-accent-600"
      } ${className}`}
    >
      <span
        className={`size-1.5 rounded-full ${verified ? "bg-brand-500" : "bg-accent-500"}`}
      />
      {verified ? "真实核验数据 · 停留时长为模拟" : "演示数据 · 非实时"}
    </span>
  );
}

export function SiteHeader({
  context,
  plan,
}: {
  context: JourneyContext;
  /**
   * 以前用来在没有真实路线时显示演示行程的「剩余时间」和路线名。D3 决定演示数据不进主流程，
   * 顶部不再显示它们；保留成可选参数只是为了不改动冻结的双人协商页面（PlanClient）。
   */
  remainingMinutes?: number;
  routeLabel?: string;
  /** 有它就说「当前生效路线」是真实核验出来的，顶部数字全部换成这一份的口径。没有真实路线时右侧什么都不显示。 */
  plan: { stops: number; totalMinutes: number; budgetMinutes: number } | null;
}) {
  return (
    <header className="border-b border-line bg-card/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-brand-700 text-lg font-semibold text-white">
            徐
          </span>
          <div>
            <h1 className="text-base leading-tight font-semibold tracking-tight text-ink-900">
              徐霞客 AI
            </h1>
            <p className="text-xs text-ink-500">走到哪儿，看到哪儿</p>
          </div>
        </div>

        <div className="hidden h-8 w-px bg-line sm:block" />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-700">
          <span className="font-medium">{context.city}</span>
          <span className="text-ink-300">·</span>
          <span>{context.district}</span>
          <span className="text-ink-300">·</span>
          <span>4 小时漫游</span>
        </div>

        {/* 只有真实核验出来的路线才在顶部报数字；没有路线时不显示演示行程的数字（D3） */}
        {plan && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <DataBadge verified />
            <span className="rounded-full border border-line bg-paper px-2.5 py-1 text-[11px] text-ink-500">
              当前生效路线 · {plan.stops} 站 · 合计 {formatMinutes(plan.totalMinutes)}
            </span>
            <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700">
              预算余 {formatMinutes(Math.max(0, plan.budgetMinutes - plan.totalMinutes))}
            </span>
          </div>
        )}
      </div>
    </header>
  );
}
