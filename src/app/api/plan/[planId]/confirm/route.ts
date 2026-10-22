import { authFailure, buildSnapshot, readBoundedJson, readToken, shortId, statusFor, viewOf } from "@/lib/server/plan-http";
import { identifyRole, noteWrite, runPlanMutation } from "@/lib/server/plan-store";
import { connection } from "next/server";

/**
 * 确认当前版本。确认永不产生新版本；
 * 只有双方确认同一个 revision 且内容指纹一致，这份方案才算正式生效。
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

  const revision = parsed.body.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 || revision > 999) {
    return Response.json({ error: "revision 必须是 1~999 的整数。" }, { status: 400 });
  }
  const contentHash = shortId(parsed.body.contentHash, "contentHash");
  if (!contentHash) return Response.json({ error: "必须带你所确认版本的 contentHash。" }, { status: 400 });

  const result = await runPlanMutation(planId, { kind: "confirm", role: identified.role, revision, contentHash });
  return Response.json({ result: viewOf(result), snapshot: buildSnapshot(planId, identified.role) }, { status: statusFor(result.code) });
}
