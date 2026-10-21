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
  remainingMinutes,
  routeLabel,
  plan,
}: {
  context: JourneyContext;
  remainingMinutes: number;
  routeLabel: string;
  /** 有它就说「当前生效路线」是真实核验出来的，顶部数字全部换成这一份的口径。 */
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

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <DataBadge verified={plan !== null} />
          <span className="rounded-full border border-line bg-paper px-2.5 py-1 text-[11px] text-ink-500">
            {plan
              ? `当前生效路线 · ${plan.stops} 站 · 合计 ${formatMinutes(plan.totalMinutes)}`
              : routeLabel}
          </span>
          <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700">
            {/* 核验前这个数是演示行程模拟出来的剩余；核验后必须是当前路线相对预算的余量，
                两个语义不能共用「剩余」这个词 */}
            {plan
              ? `预算余 ${formatMinutes(Math.max(0, plan.budgetMinutes - plan.totalMinutes))}`
              : `剩余 ${formatMinutes(remainingMinutes)}`}
          </span>
        </div>
      </div>
    </header>
  );
}
