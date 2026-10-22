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
import { connection } from "next/server";

/**
 * 双人模式里的「少走一点」：不改变任何一方的条件，只提出一个新的待确认版本。
 * 提案在双方确认之前不会替换正在正式执行的路线。
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

  const expected = parseExpectedRevision(parsed.body.expectedRevision);
  if (!expected.ok) return Response.json({ error: expected.error, code: "bad-request" }, { status: 400 });

  const attemptId = shortId(parsed.body.attemptId, "attemptId");
  if (!attemptId) return Response.json({ error: "必须带 attemptId。" }, { status: 400 });

  const result = await withPlanLock(planId, () =>
    runPlanMutation(planId, {
      kind: "propose",
      role: identified.role,
      expectedRevision: expected.value,
      attemptId,
    }),
  );
  return Response.json({ result: viewOf(result), snapshot: buildSnapshot(planId, identified.role) }, { status: statusFor(result.code) });
}
