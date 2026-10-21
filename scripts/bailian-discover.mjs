// 列出当前工作空间里的 Agent 与 Environment，用来确认 BAILIAN_AGENT_ID / BAILIAN_ENV_ID。
// 用法：npm run probe:bailian:discover
// 默认只打印脱敏 ID；加 --reveal 才打印完整 ID（Agent/Env ID 是标识符，不是密钥，但 Key 永远不打印）。
import { readFileSync, writeFileSync } from "node:fs";

const REGION = process.env.BAILIAN_REGION ?? "cn-beijing";
const KEY = process.env.DASHSCOPE_API_KEY ?? "";
const WORKSPACE = process.env.BAILIAN_WORKSPACE_ID ?? "";
const reveal = process.argv.includes("--reveal");
const writeBack = process.argv.includes("--write-back");

if (!KEY || !WORKSPACE) {
  console.log("✗ 需要 DASHSCOPE_API_KEY 与 BAILIAN_WORKSPACE_ID");
  process.exit(2);
}

const BASE = `https://${WORKSPACE}.${REGION}.maas.aliyuncs.com/api/v1/agentstudio`;
const mask = (id) => (reveal || typeof id !== "string" || id.length < 10 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`);
const scrub = (text) => String(text).split(KEY).join("sk-****");

let calls = 0;
async function get(path) {
  calls += 1;
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  console.log(`#${calls} GET ${path} → ${response.status} ${response.headers.get("content-type") ?? ""}`);
  if (!response.ok) {
    console.log(scrub(text).slice(0, 500));
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    console.log("非 JSON 响应：", scrub(text).slice(0, 300));
    return null;
  }
}

function rows(payload, label) {
  const list = payload?.data ?? payload?.items ?? payload?.agents ?? payload?.environments ?? [];
  console.log(`\n===== ${label}：${Array.isArray(list) ? list.length : "非数组"} 条 =====`);
  if (!Array.isArray(list)) {
    console.log(scrub(JSON.stringify(payload)).slice(0, 1500));
    return [];
  }
  for (const item of list) {
    const id = item.id ?? item.agent_id ?? item.environment_id ?? item.name;
    console.log(
      `  ${String(id).padEnd(40)} name=${item.name ?? "—"}  status=${item.status ?? "—"}  version=${item.version ?? item.latest_version ?? "—"}  model=${item.model ?? item.model_id ?? "—"}`,
    );
  }
  return list;
}

const agents = rows(await get("/agents?limit=100"), "GET /agents");
const envs = rows(await get("/environments?limit=100"), "GET /environments");

// --get /path 允许直接查任意资源，用来核对 Agent 本体 / 旧会话各自的配置层级。
const getPathIndex = process.argv.indexOf("--get");
if (getPathIndex !== -1) {
  for (const path of process.argv.slice(getPathIndex + 1)) {
    if (path.startsWith("--")) break;
    const detail = await get(path);
    console.log(`\n----- ${path} -----`);
    console.log(scrub(JSON.stringify(detail, null, 2)));
  }
}

if (reveal && agents.length) {
  console.log("\n----- 完整 Agent 配置（第一个）-----");
  const detail = await get(`/agents/${encodeURIComponent(agents[0].id ?? agents[0].agent_id)}`);
  console.log(scrub(JSON.stringify(detail, null, 2)).slice(0, 6000));
}

if (writeBack) {
  const pick = agents.find((a) => /feizhu|deds|霞客|xia/i.test(String(a.name ?? "") + String(a.id ?? ""))) ?? agents[0];
  const pickEnv = envs.find((e) => /default|默认/i.test(String(e.name ?? ""))) ?? envs[0];
  const agentId = pick?.id ?? pick?.agent_id;
  const envId = pickEnv?.id ?? pickEnv?.environment_id;
  if (!agentId || !envId) {
    console.log("\n✗ 没能确定 Agent 或 Environment 的 ID，不加 --reveal 看一下真实形状。");
    process.exit(1);
  }
  const file = ".env.local";
  let text = readFileSync(file, "utf8");
  const before = { agent: /BAILIAN_AGENT_ID=(.*)/.exec(text)?.[1] ?? "", env: /BAILIAN_ENV_ID=(.*)/.exec(text)?.[1] ?? "" };
  text = text.replace(/^BAILIAN_AGENT_ID=.*$/m, `BAILIAN_AGENT_ID=${agentId}`);
  text = text.replace(/^BAILIAN_ENV_ID=.*$/m, `BAILIAN_ENV_ID=${envId}`);
  writeFileSync(file, text);
  console.log(
    `\n✓ 已写回 .env.local\n  BAILIAN_AGENT_ID: ${mask(before.agent) || "(空)"} → ${mask(agentId)}\n  BAILIAN_ENV_ID:   ${mask(before.env) || "(空)"} → ${mask(envId)}`,
  );
  console.log(`  选中的 Agent 名称：${pick?.name ?? "—"}   选中的环境名称：${pickEnv?.name ?? "—"}`);
}

console.log(`\n共 ${calls} 次调用。用 --reveal 看完整配置，用 --write-back 自动写入 ID。`);
