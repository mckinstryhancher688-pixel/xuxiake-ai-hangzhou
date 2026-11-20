"use client";

/**
 * 爸妈体力评估器。
 *
 * 把两条步行约束画成「预算 vs 已用」的进度条，而不是让人从一堆档位里猜：
 *   - 全程：这一趟所有步行时间加起来，是否超过说的上限；
 *   - 单段：两站之间最长的那一段，是否超过一口气能走的距离。
 *
 * 两个数都来自服务端实测；这里只做「用了几成」的可视化，
 * 不自己比较超没超（超没超由服务端判定后传进来）。
 */

interface MeterProps {
  label: string;
  /** 一句话解释这条量的是什么 */
  hint: string;
  /** 当前值，单位由 unit 决定 */
  used: number;
  /** 上限；null 表示没设 */
  limit: number | null;
  unit: "分钟" | "米";
  /** 超过上限 */
  over: boolean;
  /** 没用满时的一句人话 */
  okText: string;
  /** 超出时的一句人话 */
  overText: string;
}

function Meter({ label, hint, used, limit, unit, over, okText, overText }: MeterProps) {
  const ratio = limit && limit > 0 ? Math.min(used / limit, 1) : 0;
  const percent = Math.round(ratio * 100);
  // 余量：没设上限时不算
  const remaining = limit !== null ? limit - used : null;

  return (
    <div className="rounded-xl border border-line bg-card p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink-900">{label}</span>
        <span className={`text-[11px] font-medium ${over ? "text-accent-600" : "text-brand-600"}`}>
          {limit === null ? "未设上限" : over ? "已超出" : `还剩 ${remaining} ${unit}`}
        </span>
      </div>
      <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-500">{hint}</p>

      {/* 进度条：底色是「这条预算」，实色是「已经用掉的」。
          没设上限时不画满格——画满会让人以为已经用完了，改成一条虚线的空槽。 */}
      {limit === null ? (
        <div className="mt-2 h-2.5 w-full rounded-full border border-dashed border-brand-100" />
      ) : (
        <div
          className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-brand-100"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={used}
          aria-label={label}
        >
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${
              over ? "bg-accent-600" : "bg-brand-600"
            }`}
            style={{ width: `${Math.max(percent, 3)}%` }}
          />
        </div>
      )}

      <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[10.5px]">
        <span className="text-ink-500">
          已用 <strong className="font-semibold text-ink-900">{used}</strong> {unit}
          {limit !== null && <> / 上限 {limit} {unit}</>}
        </span>
        {limit !== null && <span className="tabular-nums text-ink-300">{percent}%</span>}
      </div>

      <p className={`mt-1.5 text-[11px] leading-relaxed ${over ? "text-accent-600" : "text-ink-500"}`}>
        {limit === null || !over ? okText : overText}
      </p>
    </div>
  );
}

export function StaminaMeter({
  usedMinutes,
  minuteLimit,
  usedSegmentMeters,
  segmentLimitMeters,
}: {
  usedMinutes: number | null;
  minuteLimit: number | null;
  usedSegmentMeters: number | null;
  segmentLimitMeters: number | null;
}) {
  const minutes = usedMinutes ?? 0;
  const overMinutes = minuteLimit !== null && usedMinutes !== null && minutes > minuteLimit;
  const segment = usedSegmentMeters ?? 0;
  const overSegment = segmentLimitMeters !== null && usedSegmentMeters !== null && segment > segmentLimitMeters;

  return (
    <section className="space-y-2" aria-label="爸妈体力评估">
      <Meter
        label="全程走路"
        hint="这一趟所有步行时间加起来"
        used={Math.round(minutes)}
        limit={minuteLimit}
        unit="分钟"
        over={overMinutes}
        okText={
          minuteLimit === null
            ? "没有设上限，按最多能排的站数排。"
            : `还有 ${Math.max(0, minuteLimit - Math.round(minutes))} 分钟余量，走得动。`
        }
        overText={`超出 ${Math.round(minutes) - (minuteLimit ?? 0)} 分钟，需要减站或放宽。`}
      />
      <Meter
        label="一口气能走"
        hint="两站之间最长的那一段，中间没地方歇"
        used={Math.round(segment)}
        limit={segmentLimitMeters}
        unit="米"
        over={overSegment}
        okText={
          segmentLimitMeters === null
            ? "没有设上限；总量够短时一般不单独限这一段。"
            : `最长一段 ${Math.round(segment)} 米，中途不用硬撑。`
        }
        overText={`最长一段要走 ${Math.round(segment)} 米，超过一口气能走的 ${segmentLimitMeters} 米。`}
      />
    </section>
  );
}
