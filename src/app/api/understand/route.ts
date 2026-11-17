import { readBoundedJson } from "@/lib/server/plan-http";
import { understandStatus, understandText } from "@/lib/server/understand";
import { UNDERSTAND_MAX_CHARS } from "@/lib/understand";
import { connection } from "next/server";

/**
 * 读「说说爸妈的情况」那一句话。
 *
 * POST { text } → { ok, understanding, degraded, error, model, cost }
 * 每次 POST 是 1 次真实的百炼调用（有小时上限）。模型只分类、写追问；
 * 分钟数由代码从用户原话里算出来，见 lib/understand.ts。
 */
export async function POST(request: Request) {
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return parsed.response;
  const value = parsed.body.text;
  if (typeof value !== "string") {
    return Response.json({ error: "text 必须是一句话（字符串）。", code: "bad-input" }, { status: 400 });
  }
  const text = value.trim();
  if (!text) {
    return Response.json({ error: "text 不能是空的。", code: "bad-input" }, { status: 400 });
  }
  if (text.length > UNDERSTAND_MAX_CHARS) {
    return Response.json({ error: `一句话最多 ${UNDERSTAND_MAX_CHARS} 个字。`, code: "bad-input" }, { status: 400 });
  }
  const result = await understandText(text);
  return Response.json({ ok: true, ...result });
}

/** 服务端状态：是否配置、用的哪个模型、调用次数与 token。cacheComponents 下必须 connection() 才按请求读取。 */
export async function GET() {
  await connection();
  return Response.json(understandStatus());
}
