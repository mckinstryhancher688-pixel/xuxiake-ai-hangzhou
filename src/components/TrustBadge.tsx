"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 顶部唯一的状态标识。原来这里并排挂了三个胶囊（数据来源 + 生效路线 + 预算余量），
 * 首屏全是数字。现在只留一个「✓ 真实路网核验」，点开才看得到完整的数据可信说明。
 *
 * 弹窗必须用 Portal 挂到 body：header 带 backdrop-blur，会创建新的层叠上下文，
 * 弹窗留在里面时 z-index 再高也盖不住地图。
 */
export function TrustBadge({ summary }: { summary: string | null }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const dialog = open
    ? createPortal(
        <div
          className="fixed top-0 left-0 z-[999] flex h-dvh w-screen items-center justify-center bg-ink-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="数据可信说明"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-card shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold text-ink-900">数据可信说明</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-line px-2 py-1 text-[11px] text-ink-500"
              >
                关闭
              </button>
            </div>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3 text-[11.5px] leading-relaxed text-ink-600">
              <li>· 地点名称与「在飞猪查看」链接来自飞猪真实返回；行程卡逐张标注查询时间（杭州时间）。</li>
              <li>· 坐标、步行距离／时长与营业时间来自高德实测；每站停留时长是产品设定。</li>
              <li>· 「已到达」是手动模拟，不是真实 GPS。</li>
              <li>· 飞猪与高德都没有返回价格字段；本演示没有任何门票／酒店价格，不构成预算保证。</li>
              <li>· 查不到的数据一律明说（如「地址未返回」「营业时间无法核实」），绝不用常识补数字。</li>
              <li>· 无障碍洗手间为高德 POI 标注点，只显示直线距离；不代表整条路线无障碍，也不代表当天开放。</li>
            </ul>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-1.5 rounded-full border border-brand-500/40 bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700 transition hover:border-brand-600"
      >
        <span className="size-1.5 rounded-full bg-brand-500" aria-hidden />
        ✓ 真实路网核验
        {summary && <span className="font-normal text-brand-700/70">· {summary}</span>}
      </button>
      {typeof document === "undefined" ? null : dialog}
    </>
  );
}
