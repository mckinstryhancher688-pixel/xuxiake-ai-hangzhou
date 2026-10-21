// 零 token 探测：只看 POST /sessions 接受哪些会话级覆盖、以及会话快照里锁定的 agent 配置。
// 全程不发消息（发消息才会产生 token 费用），最后归档/删除探测出来的会话。
const KEY = process.env.DASHSCOPE_API_KEY;
const WORKSPACE = process.env.BAILIAN_WORKSPACE_ID;
const AGENT = process.env.BAILIAN_AGENT_ID;
const ENV_ID = process.env.BAILIAN_ENV_ID;
const REGION = process.env.BAILIAN_REGION || "cn-beijing";

if (!KEY || !WORKSPACE || !AGENT || !ENV_ID) {
  console.error("缺少必要的环境变量");
  process.exit(1);
}

const BASE = `https://${WORKSPACE}.${REGION}.maas.aliyuncs.com/api/v1/agentstudio`;

async function call(method, path, body) {
  const started = Date.now();
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
    parsed = { raw: text.slice(0, 300) };
  }
  return { status: res.status, ms: Date.now() - started, parsed };
}

/** 会话对象里只有 agent 配置是我们关心的；environment_variables 会明文回环境变量，绝不打出来。 */
function peekSession(s) {
  const agent = s?.agent ?? {};
  const tools = Array.isArray(agent.tools) ? agent.tools : [];
  const enabled = tools.flatMap((t) => (Array.isArray(t?.configs) ? t.configs : []))
    .filter((c) => c?.enabled)
    .map((c) => c.name);
  return {
    id: s?.id,
    status: s?.status,
    version: agent.version,
    model: agent.model,
    systemType: typeof agent.system,
    systemChars: typeof agent.system === "string" ? agent.system.length : null,
    toolGroups: tools.map((t) => t?.type),
    enabledTools: enabled,
    skills: Array.isArray(agent.skills) ? agent.skills.length : null,
    mcpServers: Array.isArray(agent.mcp_servers) ? agent.mcp_servers.length : null,
  };
}

const variants = [
  {
    label: "A 只覆盖 tools=[]（去掉 10 个内置工具的 schema）",
    body: {
      agent: { type: "agent_with_overrides", id: AGENT, tools: [] },
      environment_id: ENV_ID,
      title: "probe-A-tools-empty",
    },
  },
  {
    label: "B 覆盖 model（关思考 + 收紧 budget）",
    body: {
      agent: {
        type: "agent_with_overrides",
        id: AGENT,
        model: { id: "auto", enable_thinking: false, thinking_budget: 0 },
      },
      environment_id: ENV_ID,
      title: "probe-B-model-override",
    },
  },
  {
    label: "C 同时覆盖 tools=[] 与 model",
    body: {
      agent: {
        type: "agent_with_overrides",
        id: AGENT,
        tools: [],
        model: { id: "auto", enable_thinking: false, thinking_budget: 0, max_tokens: 800 },
      },
      environment_id: ENV_ID,
      title: "probe-C-tools-and-model",
    },
  },
  {
    label: "D 用 patch 包一层（另一种文档写法）",
    body: {
      agent: {
        type: "agent_with_overrides",
        id: AGENT,
        patch: { model: { id: "auto", enable_thinking: false, thinking_budget: 0 } },
      },
      environment_id: ENV_ID,
      title: "probe-D-patch-shape",
    },
  },
  {
    label: "E tools=[] 同时把常驻规则放进会话级 system",
    body: {
      agent: {
        type: "agent_with_overrides",
        id: AGENT,
        tools: [],
        system: "你是在场讲解智能体。只能使用用户消息里给出的数据；数字必须照抄，不换算不相加。",
      },
      environment_id: ENV_ID,
      title: "probe-E-tools-and-system",
    },
  },
];

const created = [];

for (const v of variants) {
  const r = await call("POST", "/sessions", v.body);
  const id = r.parsed?.id;
  console.log(`\n=== ${v.label} → HTTP ${r.status} (${r.ms}ms) ===`);
  if (!r.status.toString().startsWith("2")) {
    console.log("拒绝：", JSON.stringify(r.parsed).slice(0, 400));
    continue;
  }
  created.push(id);
  const got = await call("GET", `/sessions/${id}`);
  console.log("会话快照 agent：", JSON.stringify(peekSession(got.parsed), null, 1));
}

for (const id of created) {
  let closed = null;
  for (const [method, path] of [
    ["POST", `/sessions/${id}/archive`],
    ["DELETE", `/sessions/${id}`],
    ["POST", `/sessions/${id}/terminate`],
  ]) {
    const r = await call(method, path);
    if (r.status.toString().startsWith("2")) {
      closed = `${method} ${path} → ${r.status}`;
      break;
    }
  }
  console.log(`清理 ${id.slice(0, 6)}… ${closed ?? "没有可用的关闭端点"}`);
}
