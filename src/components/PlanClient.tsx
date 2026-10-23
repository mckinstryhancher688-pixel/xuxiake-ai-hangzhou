"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { NegotiationPanel } from "@/components/NegotiationPanel";
import { SiteHeader } from "@/components/SiteHeader";
import { usePlan, type PlanIdentity } from "@/hooks/usePlan";
import { clearPlanFragment, readPlanLink } from "@/lib/plan-api";

/**
 * 同伴那一方的落地页。
 * 凭据来自 URL fragment：首帧读完立刻清掉地址栏，此后只走请求头。
 * 这一步不做地图、不做讲解，只把「你这一方的条件 → 差异 → 确认」这条链走通。
 */
export function PlanClient({ planId }: { planId: string }) {
  const [seed, setSeed] = useState<PlanIdentity | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [linkReady, setLinkReady] = useState(false);
  const consumedLink = useRef<PlanIdentity | null>(null);

  useEffect(() => {
    let active = true;
    const readLink = () => {
      let link: ReturnType<typeof readPlanLink> = null;
      try { link = readPlanLink(); } catch { /* 损坏的转义凭据也按无效链接处理。 */ }
      clearPlanFragment();
      // Strict Mode 重放 effect 时 hash 已清掉，不覆盖刚刚读取的有效链接。
      if (!link && consumedLink.current?.planId === planId) {
        const previous = consumedLink.current;
        queueMicrotask(() => { if (active) { setSeed(previous); setLinkReady(true); } });
        return;
      }
      if (!link || link.planId !== planId) {
        const message = link ? "链接里的方案编号与地址不一致，请重新打开完整链接。"
          : "没有这一方的访问凭据，请重新打开同伴发给你的完整链接（# 后面的部分不能丢）。";
        queueMicrotask(() => { if (active) { setWarning(message); setLinkReady(true); } });
        return;
      }
      const next: PlanIdentity = { planId: link.planId, role: link.role, token: link.token, links: null };
      consumedLink.current = next;
      queueMicrotask(() => {
        if (!active) return;
        setWarning(null);
        setSeed(next);
        setLinkReady(true);
      });
    };
    readLink();
    window.addEventListener("hashchange", readLink);
    return () => { active = false; window.removeEventListener("hashchange", readLink); };
  }, [planId]);

  // 刷新后从本标签页恢复；不能误用另一个 plan 的存储身份。
  const plan = usePlan(seed?.planId === planId ? seed : null, planId, linkReady);

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader
        context={{ city: "杭州", district: "西湖湖滨", interests: [], budgetCny: 0, totalMinutes: 240 }}
        remainingMinutes={240}
        routeLabel="双人协商"
        plan={
          plan.snapshot?.canExecute.allowed && plan.snapshot.official
            ? {
                stops: plan.snapshot.official.itinerary.stops.length,
                totalMinutes: plan.snapshot.official.itinerary.totalMinutes,
                budgetMinutes: plan.snapshot.official.itinerary.budgetMinutes,
              }
            : null
        }
      />
      <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col gap-4 px-4 pt-4 pb-10">
        <p className="rounded-lg border border-line bg-paper p-3 text-xs leading-5 text-ink-500">
          这一页只服务持链接的一方：你是谁由链接决定，不是由登录决定。
          方案与确认状态都保存在服务端，刷新后回到的是当前版本。
        </p>
        {/* 链接确实失效时（撤销／过期／凭据不符），服务端给的原因比「没带凭据」更准确，优先说原因 */}
        {warning && !plan.identity && !plan.error && !plan.exited ? (
          <p className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800">{warning}</p>
        ) : null}
        {plan.identity ? (
          <NegotiationPanel plan={plan} factsId={null} />
        ) : (
          <>
            {/* 链接失效的原因（撤销／过期／凭据不符）由服务端给出，这里如实转达，不写成「等待有效链接」了事 */}
            {plan.error ? (
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">{plan.error}</p>
            ) : null}
            <p className="text-xs text-ink-500">{!linkReady ? "正在读取角色链接…" : plan.exited ? "已退出这条协商。重新打开完整角色链接才会再次进入。" : "等待有效链接。"}</p>
          </>
        )}
        <Link href="/" className="text-xs text-brand-700 underline">
          回到单人主界面
        </Link>
      </main>
    </div>
  );
}
