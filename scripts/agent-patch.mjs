// 备份并（可选）修改参赛 Agent 的模型参数。
// PATCH 是全量替换语义且带乐观锁，所以先把 GET 到的 v1 原样存盘，再基于它改字段。
// 用法：node --env-file=.env.local scripts/agent-patch.mjs          → 只备份并打印将要提交的 diff
//       node --env-file=.env.local scripts/agent-patch.mjs --apply  → 真正提交
import { writeFileSync } from "node:fs";

const KEY = process.env.DASHSCOPE_API_KEY;
const WORKSPACE = process.env.BAILIAN_WORKSPACE_ID;
const AGENT = process.env.BAILIAN_AGENT_ID;
const REGION = process.env.BAILIAN_REGION || "cn-beijing";
const APPLY = process.argv.includes("--apply");

if (!KEY || !WORKSPACE || !AGENT) {
  console.error("缺少必要的环境变量");
  process.exit(1);
}

const BASE = `https://${WORKSPACE}.${REGION}.maas.aliyuncs.com/api/v1/agentstudio`;

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  return { status: res.status, parsed };
}

const got = await call("GET", `/agents/${AGENT}`);
if (!got.status.toString().startsWith("2")) {
  console.error("GET /agents 失败", got.status, JSON.stringify(got.parsed).slice(0, 300));
  process.exit(1);
}

const current = got.parsed;
const backup = `scripts/agent-v1-backup.json`;
writeFileSync(backup, JSON.stringify(current, null, 2), "utf8");
console.log(`已备份 v${current.version} → ${backup}`);
console.log("当前 model：", JSON.stringify(current.model));

// PATCH 全量替换：只带 agent 定义里那些字段，其余（id/时间戳/request_id 等）不能提交回去。
const next = {
  name: current.name,
  description: current.description,
  model: { ...current.model, enable_thinking: false, thinking_budget: 1, max_tokens: 900 },
  system: current.system,
  tools: current.tools,
  mcp_servers: current.mcp_servers,
  skills: current.skills,
  metadata: current.metadata,
  version: current.version,
};

console.log("将提交 model：", JSON.stringify(next.model));

if (!APPLY) {
  console.log("（未提交，加 --apply 才真正 PATCH）");
  process.exit(0);
}

const patched = await call("POST", `/agents/${AGENT}`, next);
console.log(`POST → HTTP ${patched.status}`);
if (!patched.status.toString().startsWith("2")) {
  console.log("失败响应：", JSON.stringify(patched.parsed).slice(0, 600));
  process.exit(1);
}
console.log("新 model：", JSON.stringify(patched.parsed?.model), "新版本：", patched.parsed?.version);
