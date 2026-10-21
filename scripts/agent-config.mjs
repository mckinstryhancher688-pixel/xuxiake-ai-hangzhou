// 只读探测：拉取 Agent 配置与环境/模型相关的元数据，用于判断延迟与 token 的可控杠杆。
// 不发消息、不建会话，因此不消耗 token。
const KEY = process.env.DASHSCOPE_API_KEY;
const WORKSPACE = process.env.BAILIAN_WORKSPACE_ID;
const AGENT = process.env.BAILIAN_AGENT_ID;
const ENV_ID = process.env.BAILIAN_ENV_ID;
const REGION = process.env.BAILIAN_REGION || "cn-beijing";

if (!KEY || !WORKSPACE || !AGENT) {
  console.error("缺少 DASHSCOPE_API_KEY / BAILIAN_WORKSPACE_ID / BAILIAN_AGENT_ID");
  process.exit(1);
}

const BASE = `https://${WORKSPACE}.${REGION}.maas.aliyuncs.com/api/v1/agentstudio`;

function redact(value) {
  if (typeof value === "string") {
    if (/^sk-/.test(value)) return `${value.slice(0, 5)}****`;
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/key|secret|token|password|credential/i.test(k)) {
        out[k] = typeof v === "string" && v ? `${v.slice(0, 4)}****` : v;
        continue;
      }
      out[k] = redact(v);
    }
    return out;
  }
  return value;
}

async function get(path) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 500);
  }
  return { status: res.status, ms: Date.now() - started, parsed };
}

const targets = [
  `/agents/${AGENT}`,
  `/agents/${AGENT}/versions`,
  `/environments/${ENV_ID}`,
];

for (const path of targets) {
  const r = await get(path);
  console.log(`\n=== GET ${path} → HTTP ${r.status} (${r.ms}ms) ===`);
  console.log(JSON.stringify(redact(r.parsed), null, 2).slice(0, 6000));
}
