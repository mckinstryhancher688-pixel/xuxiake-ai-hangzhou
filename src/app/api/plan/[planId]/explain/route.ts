import { authFailure, readBoundedJson, readToken, shortId } from "@/lib/server/plan-http";
import { identifyRole, noteWrite } from "@/lib/server/plan-store";
import { explainNegotiation } from "@/lib/server/agent";
import { connection } from "next/server";

/**
 * 「让 AI 解释这次取舍」。
 *
 * 身份由角色凭据决定；解释读的是这条协商的当前状态，未确认的版本也可以讲——
 * 但讲归讲，执行门禁不会因为一次解释而打开。
 * 这一步会买一个真实百炼回合，所以受本方案写入上限与百炼回合上限双重约束。
 */
export async function POST(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  await connection();
  const { planId } = await params;
  const identified = identifyRole(planId, readToken(request));
  if ("error" in identified) return authFailure(identified.error);

  const limited = noteWrite(planId);
  if (!limited.allowed) return Response.json({ error: limited.reason, code: "rate-limited" }, { status: 429 });

  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return parsed.response;
  const attemptId = shortId(parsed.body.attemptId, "attemptId");
  if (!attemptId) {
    return Response.json({ error: "必须带 attemptId（同一计划的一次点击在飞行中只买一个回合）。" }, { status: 400 });
  }

  const response = await explainNegotiation({ planId, role: identified.role });
  return Response.json({ explanation: response }, { status: response.ok ? 200 : 502 });
}
