import {
  authFailure,
  buildSnapshot,
  parseExpectedRevision,
  readBoundedJson,
  readToken,
  shortId,
  statusFor,
  viewOf,
} from "@/lib/server/plan-http";
import { identifyRole, noteWrite, runPlanMutation, withPlanLock } from "@/lib/server/plan-store";
import { sanitizeConditions } from "@/lib/plan-api";
import { connection } from "next/server";

/**
 * 明确更新自己这一方的条件。
 * 顺序按评审结论：先把条件落定并挂起旧确认，再补测求解；
 * 高德失败不会撤销这个要求，也不会让超限的旧路线重新可用。
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

  const sanitized = sanitizeConditions(parsed.body.conditions, identified.role);
  if (!sanitized.ok) return Response.json({ error: sanitized.error, code: "constraint-invalid" }, { status: 400 });

  const expected = parseExpectedRevision(parsed.body.expectedRevision);
  if (!expected.ok) return Response.json({ error: expected.error, code: "bad-request" }, { status: 400 });

  const attemptId = shortId(parsed.body.attemptId, "attemptId");
  if (!attemptId) {
    return Response.json({ error: "必须带 attemptId（同一次操作重发不会重复消耗额度）。" }, { status: 400 });
  }

  const result = await withPlanLock(planId, () =>
    runPlanMutation(planId, {
      kind: "conditions",
      role: identified.role,
      conditions: sanitized.conditions,
      expectedRevision: expected.value,
      attemptId,
      confirmCost: parsed.body.confirmCost === true,
    }),
  );
  return Response.json(
    { result: viewOf(result), snapshot: buildSnapshot(planId, identified.role) },
    { status: statusFor(result.code) },
  );
}
