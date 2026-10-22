"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    const link = readPlanLink();
    clearPlanFragment();
    // 微任务里再落态：effect 同步阶段 setState 会引发级联渲染
    if (!link) {
      queueMicrotask(() => setWarning("地址栏里没带这一方的凭据，请重新打开同伴发给你的完整链接（# 后面的部分不能丢）。"));
      return;
    }
    if (link.planId !== planId) {
      queueMicrotask(() => setWarning("链接里的方案编号与地址不一致，请重新打开完整链接。"));
      return;
    }
    const next: PlanIdentity = { planId: link.planId, role: link.role, token: link.token, links: null };
    queueMicrotask(() => setSeed(next));
  }, [planId]);

  const plan = usePlan(seed);

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader
        context={{ city: "杭州", district: "西湖湖滨", interests: [], budgetCny: 0, totalMinutes: 240 }}
        remainingMinutes={240}
        routeLabel="双人协商"
        plan={
          plan.snapshot?.official
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
        {warning && !plan.error ? (
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
            <p className="text-xs text-ink-500">{plan.busy ? "正在读取协商状态…" : "等待有效链接。"}</p>
          </>
        )}
        <Link href="/" className="text-xs text-brand-700 underline">
          回到单人主界面
        </Link>
      </main>
    </div>
  );
}
