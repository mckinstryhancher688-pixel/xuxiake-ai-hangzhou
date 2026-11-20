"use client";

import { useState } from "react";

/**
 * 一站的实景小图，只画飞猪真实返回的 mainPic。
 *
 * 飞猪没给、或图加载失败时，退成一块写站名的暖灰占位——绝不拿别处的图冒充，
 * 也不画看起来像照片的假图。
 */
export function StopPhoto({
  src,
  name,
  size = 88,
}: {
  src: string | null | undefined;
  name: string;
  /** 方形边长（px）；大字版会要更大的 */
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };

  if (!src || failed) {
    return (
      <div
        className="flex shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-line bg-[#efece4] p-1.5 text-center text-brand-700/55"
        style={style}
        role="img"
        aria-label={`${name}（飞猪未返回实景图）`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="size-5" aria-hidden>
          <path d="M3 18l5-6 4 4 4-6 5 8H3z" />
          <circle cx="17" cy="7" r="2" />
        </svg>
        <span className="font-display text-[10px] leading-tight">{name.slice(0, 4)}</span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- 飞猪 CDN 的远端图，不走本地优化
    <img
      src={src}
      alt={`${name} 实景图（飞猪提供）`}
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="shrink-0 rounded-xl border border-line object-cover"
      style={style}
    />
  );
}
