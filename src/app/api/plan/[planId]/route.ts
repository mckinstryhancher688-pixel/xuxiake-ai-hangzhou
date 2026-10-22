import { authFailure, buildSnapshot, readToken } from "@/lib/server/plan-http";
import { identifyRole } from "@/lib/server/plan-store";
import { connection } from "next/server";

/**
 * 读当前协商状态。身份由令牌决定，请求里声明的角色一律不作数。
 * 刷新后回到的是服务端当前版本，而不是浏览器缓存里那一份。
 */
export async function GET(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  await connection();
  const { planId } = await params;
  const identified = identifyRole(planId, readToken(request));
  if ("error" in identified) return authFailure(identified.error);
  const snapshot = buildSnapshot(planId, identified.role);
  if (!snapshot) return authFailure("unknown-plan");
  return Response.json(snapshot);
}

export async function POST() {
  return Response.json({ error: "写操作请使用 /conditions、/propose、/confirm、/revoke。" }, { status: 405 });
}
