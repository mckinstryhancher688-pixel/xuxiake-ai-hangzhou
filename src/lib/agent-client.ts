import { AGENT_ENDPOINT } from "@/lib/agent";
import { ROLE_TOKEN_HEADER } from "@/lib/plan-api";
import type { FlyAiPoiCategory } from "@/lib/discovery";
import type {
  AdjustResponse,
  AgentServerStatus,
  AgentStreamFrame,
  ExploreResponse,
} from "@/lib/types";

export interface AgentRequest {
  intent: "arrive" | "shorten";
  cityName: string;
  stopId: string | null;
  interests: string[];
  /** 当前这份已核实行程是用哪些类别核出来的，服务端要用同一套才能读到同一条路线 */
  categories: FlyAiPoiCategory[];
  /** 上一次响应带回来的服务端票据；带上它才能续用同一条百炼会话 */
  token: string | null;
  /** 双人模式：读的是这条协商双方确认的正式版本，凭据走请求头，不放这里 */
  planId?: string | null;
}

/**
 * 浏览器只发意图，不发坐标、不发 key、更不发会话 ID。
 * 失败分两层：HTTP 层抛错（网络/服务端崩溃），业务层 ok=false 带 error 原因。
 *
 * 服务端以 text/event-stream 回复：delta 帧是智能体正在真实生成的文字（未校验，
 * 只用于进度反馈），result 帧才是复验过、可以当结论展示的数据。
 */
export async function requestAgent(
  request: AgentRequest,
  onDelta?: (text: string) => void,
  roleToken?: string | null,
): Promise<ExploreResponse | AdjustResponse> {
  const response = await fetch(AGENT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(roleToken ? { [ROLE_TOKEN_HEADER]: roleToken } : {}),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `调用失败（HTTP ${response.status}）。`);
  }

  // 参数校验一类的失败仍是普通 JSON
  if (!response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const payload = (await response.json().catch(() => null)) as
      | (ExploreResponse & AdjustResponse & { error?: string })
      | null;
    return payload ?? ({ ok: false, error: "服务端返回了空响应。", proof: null, token: null } as ExploreResponse);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: ExploreResponse | AdjustResponse | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("");
      if (!data) continue;

      let frame: AgentStreamFrame;
      try {
        frame = JSON.parse(data) as AgentStreamFrame;
      } catch {
        continue;
      }
      if (frame.type === "delta") onDelta?.(frame.text);
      else final = frame.response;
    }
  }

  return final ?? ({ ok: false, error: "流式响应提前结束，没有收到最终结果。", proof: null, token: null } as ExploreResponse);
}

export async function fetchAgentStatus(): Promise<AgentServerStatus | null> {
  try {
    const response = await fetch(AGENT_ENDPOINT);
    return response.ok ? ((await response.json()) as AgentServerStatus) : null;
  } catch {
    return null;
  }
}
