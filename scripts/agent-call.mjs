// 一次性验收 + 延迟/Token 测量脚本：直接打站内 /api/agent（SSE）。
// 用法：
//   npm run probe:agent -- arrive                 # 单次「我到了」（冷会话）
//   npm run probe:agent -- suite                  # 冷/热 × 两种意图，共 4 个回合
//   npm run probe:agent -- shorten - <token>      # 续用某条会话
const mode = process.argv[2] ?? "arrive";
const BASE = "http://localhost:3000/api/agent";
const INTERESTS = ["安静街区", "自然风光", "摄影"];

/** 发一次请求，边读流边记时间，返回 result 帧 + 浏览器视角的延迟拆解。 */
async function callOnce(intent, token) {
  const t0 = Date.now();
  const response = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent, cityName: "杭州", stopId: null, interests: INTERESTS, token }),
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstFrameMs = null;
  let firstDeltaMs = null;
  let deltaChars = 0;
  let result = null;

  const onFrame = (data) => {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (firstFrameMs === null) firstFrameMs = Date.now() - t0;
    if (frame.type === "delta") {
      if (firstDeltaMs === null) firstDeltaMs = Date.now() - t0;
      deltaChars += frame.text.length;
    } else {
      result = frame.response;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at = buffer.indexOf("\n\n");
    while (at !== -1) {
      const chunk = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      at = buffer.indexOf("\n\n");
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("");
      if (data) onFrame(data);
    }
  }

  return {
    intent,
    wallMs: Date.now() - t0,
    firstFrameMs,
    firstDeltaMs,
    deltaChars,
    result,
  };
}

const sec = (ms) => (ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`);

function report(step) {
  const proof = step.result?.proof;
  console.log(`\n=== ${step.intent} · ok=${step.result?.ok ?? "?"} · 浏览器侧总计 ${sec(step.wallMs)} ===`);
  console.log(
    `  首帧 ${sec(step.firstFrameMs)} · 首个增量 ${sec(step.firstDeltaMs)} · 流式字数 ${step.deltaChars}`,
  );
  if (step.result?.error) console.log(`  错误：${step.result.error}`);
  if (!proof) {
    console.log("  （没有凭证）");
    return;
  }
  console.log(
    `  凭证：服务端 ${sec(proof.durationMs)} · HTTP ${proof.apiCalls} 次 · 模型回合 ${proof.modelTurns} · ` +
      `输入 ${proof.usage.inputTokens} tok / 输出 ${proof.usage.outputTokens} tok / 缓存读 ${proof.usage.cacheReadTokens} tok · ` +
      `结束 ${proof.howItEnded}`,
  );
  console.log(
    `  会话覆盖：${proof.sessionOverrides.join("，") || "无"} · AUTO 实际模型：${proof.resolvedModels.join("、") || "无回执"}`,
  );
  proof.latencyPerTurn.forEach((l, index) => {
    console.log(
      `    第${index + 1}轮：建连 ${sec(l.streamConnectedMs)} → 首事件 ${sec(l.firstEventMs)} → 出字 ${sec(l.firstDeltaMs)}` +
        ` → 答案首字 ${sec(l.firstAnswerDeltaMs)} → 生成 ${sec(l.generationMs)} · 总计 ${sec(l.totalMs)}` +
        ` · 提示 ${l.promptChars} 字 · 思考 ${l.reasoningChars} 字 · 答案 ${l.answerChars} 字 · ${l.streamKinds}`,
    );
  });
}

function totals(steps) {
  const sum = steps.reduce(
    (acc, step) => {
      const proof = step.result?.proof;
      if (!proof) return acc;
      acc.input += proof.usage.inputTokens;
      acc.output += proof.usage.outputTokens;
      acc.cache += proof.usage.cacheReadTokens;
      acc.http += proof.apiCalls;
      acc.turns += proof.modelTurns;
      acc.serverMs += proof.durationMs;
      acc.wallMs += step.wallMs;
      return acc;
    },
    { input: 0, output: 0, cache: 0, http: 0, turns: 0, serverMs: 0, wallMs: 0 },
  );
  console.log(
    `\n--- 合计 ${steps.length} 个动作：模型回合 ${sum.turns} · HTTP ${sum.http} 次 · ` +
      `输入 ${sum.input} tok / 输出 ${sum.output} tok / 缓存读 ${sum.cache} tok · ` +
      `服务端 ${sec(sum.serverMs)} / 浏览器 ${sec(sum.wallMs)} ---`,
  );
}

const steps = [];

if (mode === "suite") {
  // 冷启动 = 不带票据，服务端新开一条百炼会话；热会话 = 续用同一条会话
  const coldArrive = await callOnce("arrive", null);
  report(coldArrive);
  steps.push(coldArrive);

  const hotArrive = await callOnce("arrive", coldArrive.result?.token ?? null);
  report(hotArrive);
  steps.push(hotArrive);

  const hotShorten = await callOnce("shorten", coldArrive.result?.token ?? null);
  report(hotShorten);
  steps.push(hotShorten);

  const coldShorten = await callOnce("shorten", null);
  report(coldShorten);
  steps.push(coldShorten);

  console.log(`\n会话票据（热会话用）：${coldArrive.result?.token ?? "无"}`);
} else {
  const token = process.argv[3] && process.argv[3] !== "-" ? process.argv[3] : null;
  const step = await callOnce(mode === "shorten" ? "shorten" : "arrive", token);
  report(step);
  steps.push(step);
  if (step.result) console.log(`\n完整响应：\n${JSON.stringify(step.result, null, 2)}`);
}

totals(steps);
