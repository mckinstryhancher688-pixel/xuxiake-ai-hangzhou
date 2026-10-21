// 百炼 Managed Agent 连通性探针：只在服务端运行，用真实 API 打印真实返回形状。
// 用法：npm run probe:bailian
// 任何输出都不包含 DASHSCOPE_API_KEY；Agent/Session/Request ID 一律脱敏。
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REGION = process.env.BAILIAN_REGION ?? "cn-beijing";
const KEY = process.env.DASHSCOPE_API_KEY ?? "";
const WORKSPACE = process.env.BAILIAN_WORKSPACE_ID ?? "";
const AGENT_ID = process.env.BAILIAN_AGENT_ID ?? "";
const ENV_ID = process.env.BAILIAN_ENV_ID ?? "";

const TURN_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 180_000);
const PROBE_MESSAGE =
  process.env.PROBE_MESSAGE ??
  "这是一次能力盘点，请不要安装任何东西、不要联网下载包。请依次做三件事，全部用 bash 工具执行：\n" +
  "1) 执行 `which flyai || command -v flyai || echo FLYAI_NOT_FOUND`\n" +
  "2) 执行 `ls -la` 并列出你当前实际可用的工具名称\n" +
  "3) 如果第 1 步找到了 flyai，就执行一次 `flyai search-poi --city-name 杭州 --category 自然风光 --key $FLYAI_API_KEY` 并告诉我返回了几条；如果没找到，直接回答 FLYAI_NOT_AVAILABLE。\n" +
  "最后用一句话总结：这个新会话里飞猪能力是否可用。";

const missing = [
  ["DASHSCOPE_API_KEY", KEY],
  ["BAILIAN_WORKSPACE_ID", WORKSPACE],
  ["BAILIAN_AGENT_ID", AGENT_ID],
  ["BAILIAN_ENV_ID", ENV_ID],
].filter(([, v]) => !v).map(([n]) => n);

if (missing.length > 0) {
  console.log(`✗ 缺少环境变量：${missing.join("、")}`);
  console.log("  请把值写进 .env.local（不要粘贴到聊天里），然后重新运行。");
  process.exit(2);
}

const BASE = `https://${WORKSPACE}.${REGION}.maas.aliyuncs.com/api/v1/agentstudio`;

const maskKey = (key) =>
  key.length <= 8 ? "****" : `${key.slice(0, 4)}****${key.slice(-2)}`;

const maskId = (id) => {
  if (typeof id !== "string" || id.length < 8) return id ?? "—";
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
};

const scrub = (text) => {
  let out = String(text);
  for (const secret of [KEY, WORKSPACE, AGENT_ID, ENV_ID]) {
    if (secret) out = out.split(secret).join(maskId(secret));
  }
  return out;
};

let callCount = 0;
const usage = { turns: 0, input: 0, output: 0, cacheRead: 0 };
const dump = { calls: [], events: [] };

async function call(method, path, body, { accept = "application/json", raw = false } = {}) {
  const url = `${BASE}${path}`;
  const started = Date.now();
  callCount += 1;
  const index = callCount;

  const init = {
    method,
    headers: { Authorization: `Bearer ${KEY}`, Accept: accept },
    signal: AbortSignal.timeout(raw ? TURN_TIMEOUT_MS : 30_000),
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const record = {
    index,
    method,
    // 记录路径而不是完整 URL；路径里含脱敏后的 session id
    path: scrub(path),
    requestBody: body === undefined ? null : JSON.parse(scrub(JSON.stringify(body))),
  };

  try {
    const response = await fetch(url, init);
    const text = await response.text();
    record.httpStatus = response.status;
    record.requestId = response.headers.get("x-request-id") ?? response.headers.get("x-acs-request-id") ?? null;
    record.contentType = response.headers.get("content-type");
    record.durationMs = Date.now() - started;

    let parsed = null;
    if (!raw) {
      try {
        parsed = JSON.parse(text);
      } catch {
        record.parseError = text.slice(0, 400);
      }
    }
    record.parsed = parsed ? JSON.parse(scrub(JSON.stringify(parsed))) : null;
    if (raw) record.rawHead = scrub(text.slice(0, 4000));
    dump.calls.push(record);
    console.log(
      `#${String(index).padStart(2, "0")} ${method} ${record.path} → ${response.status} (${record.durationMs}ms)` +
        (record.requestId ? ` req=${maskId(record.requestId)}` : ""),
    );
    if (!response.ok) console.log(`     ↳ ${scrub(text).slice(0, 600)}`);
    return { ok: response.ok, status: response.status, text, parsed, response };
  } catch (error) {
    record.error = scrub(error?.message ?? String(error));
    record.durationMs = Date.now() - started;
    dump.calls.push(record);
    console.log(`#${String(index).padStart(2, "0")} ${method} ${record.path} → 抛错：${record.error}`);
    return { ok: false, status: 0, text: "", parsed: null, error: error?.message };
  }
}

function printShape(label, value) {
  console.log(`\n===== ${label} =====`);
  console.log(scrub(JSON.stringify(value, null, 2))?.slice(0, 6000) ?? "null");
}

/** SSE 帧解析：以空行分帧，多行 data: 合并，忽略以 : 开头的注释/keepalive。 */
function makeSseParser(onFrame) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^\s/, ""));
      }
      if (dataLines.length === 0) continue;
      const raw = dataLines.join("\n");
      try {
        onFrame(JSON.parse(raw));
      } catch {
        console.log(`  ! 无法解析的 SSE data：${scrub(raw).slice(0, 200)}`);
      }
    }
  };
}

function describeEvent(event) {
  const type = event.type ?? event.object;
  const summary = {
    id: event.id ? maskId(event.id) : null,
    type,
    role: event.role ?? null,
    createdAt: event.created_at ?? null,
    isError: event.is_error ?? null,
  };
  if (type === "event_start") {
    summary.kind = "delta_start";
    summary.starts = `${maskId(event.event?.id)}:${event.event?.type}`;
  } else if (type === "event_delta") {
    summary.kind = "delta";
    summary.of = maskId(event.event_id);
    summary.blockIndex = event.delta?.index ?? null;
    summary.text = event.delta?.content?.type === "text" ? event.delta.content.text : null;
  } else if (event.error) {
    summary.kind = "error";
    summary.error = event.error;
  } else if (type === "model_request_end") {
    const data = event.content?.find((c) => c.type === "data")?.data ?? {};
    summary.kind = "usage";
    summary.model = data.model ?? null;
    summary.inputTokens = data.input_tokens ?? 0;
    summary.outputTokens = data.output_tokens ?? 0;
    summary.cacheReadTokens = data.cache_read_input_tokens ?? 0;
    summary.isError = data.is_error ?? false;
    usage.turns += 1;
    usage.input += summary.inputTokens;
    usage.output += summary.outputTokens;
    usage.cacheRead += summary.cacheReadTokens;
  } else if (type === "model_request_start") {
    summary.kind = "usage_start";
    summary.model = event.content?.find((c) => c.type === "data")?.data?.model ?? null;
  } else if (typeof type === "string" && type.includes("call")) {
    summary.kind = "tool";
    const data = event.content?.find((c) => c.type === "data")?.data;
    summary.toolName = data?.name ?? null;
    summary.callId = data?.call_id ? maskId(data.call_id) : null;
    summary.arguments = data?.arguments ?? null;
    summary.output = typeof data?.output === "string" ? data.output.slice(0, 500) : data?.output ?? null;
  } else if (type === "session_status") {
    summary.kind = "status";
    const data = event.content?.find((c) => c.type === "data")?.data;
    summary.sessionStatus = data?.session_status ?? null;
    summary.stopReason = data?.stop_reason ?? null;
  } else {
    summary.kind = "message";
    summary.text = (event.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return summary;
}

async function main() {
  console.log(`目标域名：${scrub(BASE)}`);
  console.log(`Agent：${maskId(AGENT_ID)}  Environment：${maskId(ENV_ID)}  Workspace：${maskId(WORKSPACE)}`);
  console.log(`Key：${maskKey(KEY)}\n`);

  // 1. Agent 配置与版本
  const agent = await call("GET", `/agents/${AGENT_ID}`);
  if (agent.ok) printShape("GET /agents/{agent_id} 的真实返回形状", agent.parsed);
  await call("GET", `/agents/${AGENT_ID}/versions`);
  await call("GET", `/environments/${ENV_ID}`);

  // 2. 新建测试 Session
  const session = await call("POST", "/sessions", {
    agent: { type: "agent", id: AGENT_ID },
    environment_id: ENV_ID,
    title: "probe-徐霞客连通性",
  });
  if (!session.ok || !session.parsed?.id) {
    printShape("创建 Session 失败，原始返回", session.parsed ?? session.text);
    finish(null, null);
    return;
  }
  const sessionId = session.parsed.id;
  console.log(`\n✓ Session 已创建：${maskId(sessionId)}  status=${session.parsed.status ?? "—"}`);

  // 3+4. 先订阅 SSE，再提交消息（文档明确：顺序不能反，SSE 不回放历史）
  const seen = [];
  let turnDone = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const streamUrl = `${BASE}/sessions/${encodeURIComponent(sessionId)}/events/stream?event_deltas%5B%5D=message&event_deltas%5B%5D=reasoning`;
  const controller = new AbortController();
  const streamCall = { index: ++callCount, method: "GET", path: scrub(`/sessions/${sessionId}/events/stream`), stream: true };
  dump.calls.push(streamCall);
  console.log(`#${String(streamCall.index).padStart(2, "0")} GET ${streamCall.path} (SSE 订阅)`);

  const onFrame = (event) => {
    const described = describeEvent(event);
    seen.push(described);
    dump.events.push(JSON.parse(scrub(JSON.stringify(event))));
    if (described.kind === "delta" && described.text) process.stdout.write(".");
    else if (described.kind === "tool") console.log(`\n  ⚙ ${described.type} ${described.toolName ?? "?"}`);
    else if (described.kind === "status") console.log(`\n  ● session_status=${described.sessionStatus} stop_reason=${JSON.stringify(described.stopReason)}`);
    else if (described.kind === "error") console.log(`\n  ✗ error 事件：${JSON.stringify(described.error)}`);
    else if (described.kind === "message" && described.text) console.log(`\n  ▣ ${described.type}/${described.role}: ${described.text.slice(0, 160)}`);

    if (described.kind === "status" && ["idle", "terminated", "error"].includes(described.sessionStatus)) {
      turnDone = described.sessionStatus;
      resolveDone?.("status");
    }
    if (described.kind === "error") {
      turnDone = "error";
      resolveDone?.("error");
    }
  };

  fetch(streamUrl, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "text/event-stream" },
    signal: controller.signal,
  })
    .then(async (response) => {
      streamCall.httpStatus = response.status;
      streamCall.contentType = response.headers.get("content-type");
      console.log(`     ↳ SSE ${response.status} ${response.headers.get("content-type")}`);
      if (!response.ok) {
        streamCall.rawHead = scrub(await response.text()).slice(0, 800);
        resolveDone?.("stream-failed");
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const push = makeSseParser(onFrame);
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        push(decoder.decode(value, { stream: true }));
      }
      resolveDone?.("stream-end");
    })
    .catch((error) => {
      streamCall.error = scrub(error?.message ?? String(error));
      resolveDone?.("stream-error");
    });

  await new Promise((r) => setTimeout(r, 1200));

  const posted = await call("POST", `/sessions/${sessionId}/events`, {
    input: [{ role: "user", type: "message", content: [{ type: "text", text: PROBE_MESSAGE }]}],
  });
  if (posted.ok) printShape("发送消息后服务端回执形状", posted.parsed);

  const timer = setTimeout(() => resolveDone?.("timeout"), TURN_TIMEOUT_MS);
  const how = await done;
  clearTimeout(timer);
  controller.abort();

  console.log(`\n轮次结束方式：${how}  session_status=${turnDone ?? "未观测到"}  共收到 ${seen.length} 个事件`);

  const finalMessage = [...seen].reverse().find((e) => e.kind === "message" && e.type === "message" && e.text);
  const toolEvents = seen.filter((e) => e.kind === "tool");
  console.log(`\n----- 工具调用事件 ${toolEvents.length} 个 -----`);
  for (const t of toolEvents) {
    console.log(`  [${t.type}] ${t.toolName ?? "?"} call=${t.callId ?? "—"} error=${t.isError ?? "—"}`);
    if (t.arguments) console.log(`     args: ${JSON.stringify(t.arguments).slice(0, 300)}`);
    if (t.output) console.log(`     out : ${String(t.output).slice(0, 300)}`);
  }
  const flyaiTool = toolEvents.find((t) => /fly|飞猪|feizhu|poi/i.test(String(t.toolName ?? "")));
  console.log(`\n飞猪工具是否被调用：${flyaiTool ? `是 → ${flyaiTool.toolName}` : "否（本回合没有任何名字含 fly/飞猪/poi 的工具事件）"}`);

  console.log("\n----- Agent 最终文本 -----");
  console.log(finalMessage?.text ?? "(没有观测到完整的 message 文本)");

  console.log(
    `\n----- Token 用量（来自 model_request_end 事件）-----\n  模型请求 ${usage.turns} 次：输入 ${usage.input} / 输出 ${usage.output} / 缓存命中读 ${usage.cacheRead}`,
  );

  await call("GET", `/sessions/${sessionId}/events?order=asc&limit=100`);
  printShape("历史事件列表（前几条）", (dump.calls.at(-1)?.parsed?.data ?? []).slice(0, 4));

  finish(sessionId, how);
}

function finish(sessionId, how) {
  const outFile = join(tmpdir(), "bailian-probe-dump.json");
  writeFileSync(
    outFile,
    scrub(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          host: `${maskId(WORKSPACE)}.${REGION}.maas.aliyuncs.com`,
          agentId: maskId(AGENT_ID),
          environmentId: maskId(ENV_ID),
          sessionId: sessionId ? maskId(sessionId) : null,
          howItEnded: how,
          totalCalls: callCount,
          tokenUsage: usage,
          ...dump,
        },
        null,
        2,
      ),
    ),
  );
  console.log(`\n真实返回已存：${outFile}`);
  console.log(`本次探针共发起 ${callCount} 次百炼调用。`);
}

main().catch((error) => {
  console.error("探针异常：", scrub(error?.message ?? String(error)));
  finish(null, "crash");
  process.exit(1);
});
