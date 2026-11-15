import type { ToiletLookup } from "@/lib/types";

/**
 * 行程卡上的一行无障碍洗手间。
 *
 * 只写高德真实标注的点与直线距离；找不到就什么都不显示（不写「附近有」这种含糊话）。
 * 刻意不在每站都堆一行说明——口径说明放到面板级一次讲清，避免每张卡片重复六行免责。
 */
export function StopToiletLine({
  lookup,
  stopName,
}: {
  lookup: ToiletLookup | null | undefined;
  stopName: string;
}) {
  if (!lookup) return null;
  const hit = lookup.nearest.find((item) => item.anchorName === stopName);
  if (!hit) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1 text-[9px] leading-relaxed text-ink-500">
      <span className="rounded bg-brand-600/10 px-1 py-px font-medium text-brand-700">无障碍洗手间</span>
      <span className="text-ink-400">
        {hit.toiletName} · 直线 {hit.straightLineMeters} 米
      </span>
    </span>
  );
}

/** 面板级口径说明：只在有数据时出现，且必须写清「不代表整条路线无障碍」。 */
export function ToiletScopeNote({ lookup }: { lookup: ToiletLookup | null | undefined }) {
  if (!lookup || !lookup.nearest.length) return null;
  return (
    <p className="mt-2 rounded-lg bg-paper px-2 py-1.5 text-[10px] leading-relaxed text-ink-500 ring-1 ring-line">
      无障碍洗手间来自高德 POI 标注（分类码 200303），显示的是<strong className="font-medium text-ink-700">直线距离、不是步行距离</strong>
      ；只统计直线 800 米内的点。它<strong className="font-medium text-ink-700">不代表整条路线无障碍，也不代表当天开放</strong>
      。{lookup.newCalls === 0 ? "（本次查询命中缓存，未新增高德调用）" : ""}
    </p>
  );
}
