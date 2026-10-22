import { authFailure, buildSnapshot, readToken } from "@/lib/server/plan-http";
import { identifyRole, runPlanMutation, withPlanLock } from "@/lib/server/plan-store";
import { connection } from "next/server";

/**
 * 撤销：只有发起方（A）能撤。撤销后两条角色链接立即失效，
 * 已有的行程与确认记录都不再可执行；重建方案复用同一事实层，不新增高德调用。
 */
export async function POST(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  await connection();
  const { planId } = await params;
  const identified = identifyRole(planId, readToken(request));
  if ("error" in identified) return authFailure(identified.error);
  if (identified.role !== "A") {
    return Response.json({ error: "只有发起方（A）能撤销这条协商。", code: "forbidden-role" }, { status: 403 });
  }

  const result = await withPlanLock(planId, () => runPlanMutation(planId, { kind: "revoke", role: "A" }));
  return Response.json({ result, snapshot: buildSnapshot(planId, "A") });
}
