import type { JourneyContext } from "@/lib/types";
import { formatMinutes } from "@/lib/format";
import { TrustBadge } from "@/components/TrustBadge";

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
          <span className="grid size-10 place-items-center rounded-xl bg-brand-700 font-display text-lg font-bold text-white">
            徐
          </span>
          <div>
            <h1 className="font-display text-base leading-tight font-bold tracking-tight text-brand-700">
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

        {/* 顶部只留一个标识；完整的口径说明点开才看，不再三颗胶囊并排占满右侧 */}
        {plan && (
          <div className="ml-auto">
            <TrustBadge summary={`${plan.stops} 站 · ${formatMinutes(plan.totalMinutes)}`} />
          </div>
        )}
      </div>
    </header>
  );
}
