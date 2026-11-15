"use client";

import { useEffect, useState } from "react";
import type { ToiletLookup, VerifiedItinerary } from "@/lib/types";

/**
 * 给爸妈看的大字版。
 *
 * 这不是把字号调大，而是换一套信息结构：只留「去哪几个地方、走多久、哪能歇」，
 * 数值全部由服务端算好后传进来；这里不做任何判断，也不写「应该没问题」这种话。
 *
 * 刻意去掉的东西：技术证明、来源标签、差异表、正负号、按钮堆叠。
 * 刻意保留的东西：每一段多长（可核对）、总长、有没有超、厕所在哪、免责口径。
 */

const MIN_FONT_SCALE = 1;
const MAX_FONT_SCALE = 1.8;

export function ElderView({
  open,
  onClose,
  itinerary,
  toilets,
  limitMeters,
  segmentLimitMeters,
}: {
  open: boolean;
  onClose: () => void;
  itinerary: VerifiedItinerary | null;
  toilets?: ToiletLookup | null;
  limitMeters: number | null;
  segmentLimitMeters: number | null;
}) {
  const [scale, setScale] = useState(1.25);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const stops = itinerary?.stops ?? [];
  const legs = itinerary?.legs ?? [];
  const totalMin = itinerary ? itinerary.totalWalkMinutes + itinerary.totalStayMinutes + itinerary.bufferMinutes : 0;
  const longest = legs.length ? Math.max(...legs.map((leg) => leg.distanceMeters)) : 0;
  const overLimit = limitMeters !== null && itinerary !== null && itinerary.totalWalkMeters > limitMeters;
  const overSegment = segmentLimitMeters !== null && longest > segmentLimitMeters;

  const px = (base: number) => `${Math.round(base * scale)}px`;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white" role="dialog" aria-modal="true" aria-label="给爸妈看的行程">
      {/* 顶部：只有字号调节与退出，避免误触 */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
        <span className="font-semibold text-ink-900" style={{ fontSize: px(20) }}>这次怎么走</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="缩小字号"
            onClick={() => setScale((s) => Math.max(MIN_FONT_SCALE, Number((s - 0.15).toFixed(2))))}
            className="rounded-xl border-2 border-line px-4 py-2 font-semibold text-ink-700"
            style={{ fontSize: px(16) }}
          >
            字小
          </button>
          <button
            type="button"
            aria-label="放大字号"
            onClick={() => setScale((s) => Math.min(MAX_FONT_SCALE, Number((s + 0.15).toFixed(2))))}
            className="rounded-xl border-2 border-line px-4 py-2 font-semibold text-ink-700"
            style={{ fontSize: px(16) }}
          >
            字大
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-ink-900 px-4 py-2 font-semibold text-white"
            style={{ fontSize: px(16) }}
          >
            退出
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!itinerary || !stops.length ? (
          <p className="font-medium text-ink-700" style={{ fontSize: px(22), lineHeight: 1.7 }}>
            还没有排好的路线。先请孩子在外面生成一条。
          </p>
        ) : (
          <>
            {/* 一句话总览：最想让人一眼看到的就这三行 */}
            <div className="space-y-3">
              <p className="font-semibold text-ink-900" style={{ fontSize: px(24), lineHeight: 1.6 }}>
                一共去 {stops.length} 个地方
              </p>
              <p className="text-ink-800" style={{ fontSize: px(22), lineHeight: 1.7 }}>
                从头到尾走路 <strong>{itinerary.totalWalkMeters}</strong> 米，
                大约 <strong>{itinerary.totalWalkMinutes}</strong> 分钟。
              </p>
              <p className="text-ink-800" style={{ fontSize: px(22), lineHeight: 1.7 }}>
                中间坐下休息的时间算在里面，全程大约 <strong>{Math.round(totalMin / 60 * 10) / 10}</strong> 小时。
              </p>

              {limitMeters !== null && (
                <p
                  className={`rounded-2xl px-4 py-3 font-semibold ${overLimit ? "bg-red-50 text-red-700" : "bg-green-50 text-green-800"}`}
                  style={{ fontSize: px(22), lineHeight: 1.6 }}
                >
                  {overLimit
                    ? `注意：这条路的走路距离超过了说好的 ${limitMeters} 米。`
                    : `没有超过说好的 ${limitMeters} 米。`}
                </p>
              )}
              {segmentLimitMeters !== null && (
                <p
                  className={`rounded-2xl px-4 py-3 font-semibold ${overSegment ? "bg-red-50 text-red-700" : "bg-green-50 text-green-800"}`}
                  style={{ fontSize: px(22), lineHeight: 1.6 }}
                >
                  {overSegment
                    ? `注意：有一段要连着走 ${longest} 米，超过了说好的 ${segmentLimitMeters} 米。`
                    : `最长的一段连着走 ${longest} 米，没有超过说好的 ${segmentLimitMeters} 米。`}
                </p>
              )}
            </div>

            {/* 逐站：地名 + 到下一站多远 + 厕所在哪 */}
            <ol className="mt-6 space-y-5">
              {stops.map((stop, index) => {
                const leg = legs[index];
                const toilet = toilets?.nearest?.find((item) => item.anchorName === stop.name);
                return (
                  <li key={`${stop.flyaiId}-${index}`} className="rounded-2xl border-2 border-line px-4 py-4">
                    <p className="font-bold text-ink-900" style={{ fontSize: px(26), lineHeight: 1.5 }}>
                      {index + 1}. {stop.name}
                    </p>
                    <p className="mt-1 text-ink-600" style={{ fontSize: px(18), lineHeight: 1.6 }}>
                      在这儿待大约 {stop.stayMinutes} 分钟
                    </p>
                    {leg && (
                      <p className="mt-2 text-ink-800" style={{ fontSize: px(21), lineHeight: 1.6 }}>
                        往下走 <strong>{leg.distanceMeters}</strong> 米，约 <strong>{leg.durationMinutes}</strong> 分钟
                      </p>
                    )}
                    {toilet && (
                      <p className="mt-2 text-ink-700" style={{ fontSize: px(20), lineHeight: 1.6 }}>
                        附近有无障碍厕所：直线 {toilet.straightLineMeters} 米
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>

            {/* 口径：不藏起来，但也不喧宾夺主 */}
            <div className="mt-6 rounded-2xl bg-paper px-4 py-4">
              <p className="text-ink-600" style={{ fontSize: px(16), lineHeight: 1.7 }}>
                走路距离是高德地图量出来的，不是人真走一遍的时间。
                每站待多久、中间留多少空余，是我们设定的，不是实测。
                这些距离只算从起点到最后一个地方，不算回程、也不算进景区里面还要走多少。
              </p>
              <p className="mt-2 text-ink-600" style={{ fontSize: px(16), lineHeight: 1.7 }}>
                厕所是地图上标了「无障碍」的点，只算直线距离，不代表整条路都能推轮椅，也不代表那天开着。
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
