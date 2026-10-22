import { PlanClient } from "@/components/PlanClient";

export const metadata = { title: "双人协商 · 徐霞客 AI" };

/** 这一页必须按链接里的 planId 渲染，不能预渲染成静态壳：缓存策略下显式声明阻塞渲染。 */
export const instant = false;

export default async function PlanPage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  return <PlanClient planId={planId} />;
}
