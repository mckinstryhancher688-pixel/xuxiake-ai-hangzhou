import { pickCity } from "@/lib/discovery";
import { agentServerStatus, exploreWithAgent, shortenWithAgent } from "@/lib/server/agent";
import type { AdjustResponse, AgentStreamFrame, ExploreResponse } from "@/lib/types";
import { connection } from "next/server";

interface AgentRequestBody {
  intent?: unknown;
  token?: unknown;
  cityName?: unknown;
  stopId?: unknown;
  interests?: unknown;
}

/** 增量帧太碎会压垮浏览器渲染，攒到这么长或这么久没出字再发一帧。 */
const FLUSH_CHARS = 24;
const FLUSH_MS = 160;

/**
 * 服务端状态。cacheComponents 下 GET 会被预渲染，
 * 必须 await connection() 才能每次实时读 env 与调用计数。
 * 返回体里只有脱敏后的 ID 与用量，绝不包含 key 或裸会话对象。
 */
export async function GET() {
  await connection();
  return Response.json(await agentServerStatus());
}

/**
 * 智能体开始出字就往下推 delta 帧，服务端复验完才推 result 帧。
 * delta 只用于「真的在生成」的进度反馈，未经校验，不能当结论展示。
 */
function streamAgent(
  intent: "arrive" | "shorten",
  journey: { cityName: string; stopId: string | null; interests: string[] },
  token: string | null,
): Response {
  let pump: (chunk: string) => void = () => {};
  let seal: (frame: AgentStreamFrame) => void = () => {};
  let abort: (reason: string) => void = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      // 浏览器中途关页面 → 流已关闭，此时 enqueue 会抛。异常若从 onDelta 反向传进智能体回合，
      // 会把一次「客户端断开」变成服务端未处理拒绝；钱已经花了，这里只静默丢弃后续帧。
      const send = (frame: AgentStreamFrame) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          /* 客户端已断开 */
        }
      };
      let pending = "";
      let timer: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (!pending) return;
        const text = pending;
        pending = "";
        send({ type: "delta", text });
      };

      pump = (chunk) => {
        pending += chunk;
        if (pending.length >= FLUSH_CHARS) {
          flush();
          return;
        }
        if (!timer) timer = setTimeout(flush, FLUSH_MS);
      };
      seal = (frame) => {
        flush();
        send(frame);
        try {
          controller.close();
        } catch {
          /* 客户端已断开 */
        }
      };
      // 流已经开了就没有状态码可用：异常改用 result 帧说明原因，绝不静默
      abort = (reason) => {
        seal({
          type: "result",
          response: {
            ok: false,
            error: reason,
            proof: null,
            token,
          } as unknown as ExploreResponse & AdjustResponse,
        });
      };
    },
  });

  const run =
    intent === "arrive"
      ? exploreWithAgent(journey, token, { onDelta: (text) => pump(text) })
      : shortenWithAgent(journey, token, { onDelta: (text) => pump(text) });

  run.then(
    (response) => seal({ type: "result", response }),
    (caught: unknown) => abort(caught instanceof Error ? caught.message : String(caught)),
  );

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * 「我到了」与「少走一点」共用的入口。
 * 浏览器只提交意图 + 站点 id + 会话票据，坐标与已核实数据全部由服务端自己取。
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  // 正常请求只有几百字节。这条上限挡住用巨型 prompt 灌本端点：超限直接 413，不建会话、不进模型。
  if (rawBody.length > 8_192) {
    return Response.json(
      { error: "请求体过大（本端点只接受意图、站点 id、兴趣标签与会话票据）。" },
      { status: 413 },
    );
  }
  let body: AgentRequestBody | null = null;
  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as AgentRequestBody;
    } catch {
      return Response.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
    }
  }

  const intent = body?.intent;
  if (intent !== "arrive" && intent !== "shorten") {
    return Response.json(
      { error: `intent 只能是 arrive 或 shorten，收到「${String(intent ?? "空")}」。` },
      { status: 400 },
    );
  }

  const cityName = pickCity(body?.cityName);
  if (!cityName) {
    return Response.json(
      { error: `本阶段只支持杭州，收到的 cityName 是「${String(body?.cityName ?? "空").slice(0, 40)}」。` },
      { status: 400 },
    );
  }

  // 站点 id 与票据都会被服务端拿去做映射键，所以限制长度；内容合法性由 resolveJourney 与会话表判定
  const stopId = typeof body?.stopId === "string" && body.stopId.length <= 64 ? body.stopId : null;
  const token = typeof body?.token === "string" && body.token.length <= 64 ? body.token : null;
  const interests = Array.isArray(body?.interests)
    ? body.interests.filter((item): item is string => typeof item === "string")
    : [];

  // 参数不合法仍是普通 JSON + HTTP 400；进入智能体后改为流式响应
  return streamAgent(intent, { cityName, stopId, interests }, token);
}
