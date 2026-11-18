/**
 * 「说说爸妈的情况」零付费回归：时长换算、模型回复的校验、服务端调用链路、/api/understand 路由。
 *
 * globalThis.fetch 换成桩、密钥是假的：本套件不会发出任何真实请求，也不花一分钱。
 * 桩返回的「模型回复」是手写的，只用来验证我们的校验规则；模型真实表现要另跑付费探针（需先报预算）。
 * 跑法：node --import ./evidence/register-alias.mjs evidence/understand-unit.mjs
 */
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
};

/* ── 桩：记录每一次外发请求，按 mode 返回 ── */
const outbound = [];
let mode = { kind: "reply", content: "{}" };
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  outbound.push({ url, headers: init?.headers ?? {}, body });
  if (!url.includes(".maas.aliyuncs.com/compatible-mode/v1/chat/completions")) {
    throw new Error(`本套件不允许这个外部调用：${url.slice(0, 60)}`);
  }
  if (mode.kind === "throw") throw new Error("socket hang up (stub)");
  if (mode.kind === "http") {
    return new Response(JSON.stringify({ error: { code: mode.code, message: "stub" } }), { status: mode.status });
  }
  if (mode.kind === "garbage") return new Response("<html>oops</html>", { status: 200 });
  return new Response(
    JSON.stringify({
      model: body?.model ?? "stub",
      choices: [{ message: { role: "assistant", content: mode.content } }],
      usage: { prompt_tokens: 420, completion_tokens: 30 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const FAKE_KEY = "sk-fake-understand-0123456789";
const FAKE_WS = "ws-fake-workspace-9876";

const lib = await import("../src/lib/understand.ts");
const { parseDurationMinutes, safeQuestion, judgeModelReply, DEFAULT_QUESTION, UNDERSTAND_SYSTEM_PROMPT } = lib;

/* ═════ A. 时长换算：只认确定的说法 ═════ */
const durationCases = [
  ["最多走一个小时", 60], ["一小时", 60], ["1小时", 60], ["１小时", 60], ["一个钟头", 60],
  ["半小时", 30], ["半个小时", 30], ["半个钟头", 30],
  ["一个半小时", 90], ["一小时半", 90], ["1.5小时", 90], ["1.5 个小时", 90],
  ["两个小时", 120], ["2小时", 120], ["一小时二十分钟", 80], ["1小时20分", 80],
  ["四十分钟", 40], ["40分钟", 40], ["十五分钟", 15], ["二十五分钟", 25],
  ["一刻钟", 15], ["三刻钟", 45], ["1.1小时", 66],
  // 以下都必须返回 null：含糊、范围、约数、并列数字、两个时长、不是步行时长
  ["个把小时", null], ["一两个小时", null], ["半小时到一小时", null], ["40-60分钟", null],
  ["一个多小时", null], ["半个多小时", null], ["二十多分钟", null], ["十来分钟", null],
  ["几十分钟", null], ["十几分钟", null], ["二三十分钟", null], ["半天", null],
  ["十分累", null], ["走不了多久", null], ["最多一小时，最少半小时", null], ["1.33小时", null], ["", null],
];
const durationFails = durationCases
  .map(([input, expected]) => ({ input, expected, actual: parseDurationMinutes(input) }))
  .filter((row) => row.actual !== row.expected);
check(`A1 时长换算 ${durationCases.length} 例全部符合期望（含 ${durationCases.filter((c) => c[1] === null).length} 例必须拒绝的含糊说法）`, durationFails.length === 0, durationFails);

/* ═════ B. 追问校验：不许出现用户没说过的时长或距离 ═════ */
const knee = "我妈膝盖不好";
check("B1 正常追问通过", safeQuestion("阿姨膝盖不好，全程一共大概能走多久？", knee) === "阿姨膝盖不好，全程一共大概能走多久？");
check("B2 追问里出现用户没说过的时长 → 作废", safeQuestion("阿姨能走 30 分钟吗？全程能走多久？", knee) === null);
check("B3 追问里出现中文时长（用户没说过）→ 作废", safeQuestion("走半小时可以吗，全程能走多久？", knee) === null);
check("B4 追问里出现距离 → 作废", safeQuestion("两公里能走吗？全程能走多久？", knee) === null);
check("B5 复述用户自己说的时长 → 允许", safeQuestion("阿姨走半小时就得歇，那全程加起来能走多久？", "我妈走半小时就得歇") !== null);
check("B6 不是在问「多久」→ 作废", safeQuestion("阿姨喜欢看什么？", knee) === null);
check("B7 没有问号结尾 → 作废", safeQuestion("全程能走多久", knee) === null);
check("B8 过长（>40 字）→ 作废", safeQuestion(`${"阿".repeat(40)}能走多久？`, knee) === null);
check("B9 非字符串 → 作废", safeQuestion(42, knee) === null && safeQuestion(null, knee) === null);

/* ═════ C. 模型回复 → 结论：模型说的只是线索 ═════ */
const reply = (obj) => JSON.stringify(obj);

const t1 = judgeModelReply("我妈全程最多走一个小时", reply({ kind: "total", quote: "全程最多走一个小时", question: "", other: [] }));
check("C1 明确的全程时长 → 60 分钟，quote 原样保留", t1.kind === "minutes" && t1.minutes === 60 && t1.quote === "全程最多走一个小时" && t1.source === "model", t1);
check("C1b 说明由代码生成并复述原话", t1.note === "按您说的「全程最多走一个小时」，定为 1 小时。", t1.note);

const t2 = judgeModelReply("我妈最多走一个小时", reply({ kind: "total", quote: "最多走两个小时", question: "", other: [] }));
check("C2 quote 不是原文（模型改了数字）→ 不采信，改为追问", t2.kind === "ask" && t2.minutes === null && t2.question === DEFAULT_QUESTION, t2);

const t3 = judgeModelReply("我妈走半小时就得歇", reply({ kind: "total", quote: "走半小时", question: "", other: [] }));
check("C3 模型把「一口气」当成全程 → 代码拦下，改为追问并讲明", t3.kind === "ask" && t3.minutes === null && /一口气/.test(t3.note ?? ""), t3);

const t4 = judgeModelReply("我妈走半小时就得歇，全程最多一个半小时", reply({ kind: "total", quote: "全程最多一个半小时", question: "", other: [] }));
check("C4 前半句的「就得歇」不连累后半句的全程上限 → 90 分钟", t4.kind === "minutes" && t4.minutes === 90, t4);

const t5 = judgeModelReply("能走个把小时吧", reply({ kind: "total", quote: "个把小时", question: "", other: [] }));
check("C5 含糊时长 → 不换算，追问", t5.kind === "ask" && t5.minutes === null && /没法换成确定的分钟数/.test(t5.note ?? ""), t5);

const t6 = judgeModelReply("只能走三分钟", reply({ kind: "total", quote: "三分钟", question: "", other: [] }));
check("C6 短于 5 分钟 → 不硬排，追问并说明太短", t6.kind === "ask" && /太短/.test(t6.note ?? ""), t6);

const t7 = judgeModelReply("我爸能走五个小时", reply({ kind: "total", quote: "五个小时", question: "", other: [] }));
check("C7 超过半日总时长 → 不设上限，并说明原因", t7.kind === "minutes" && t7.minutes === null && /不设上限/.test(t7.note ?? ""), t7);

const t8 = judgeModelReply(knee, reply({ kind: "ask", quote: "", question: "阿姨膝盖不好，全程一共大概能走多久？", other: [] }));
check("C8 只说身体情况 → 采用模型写的追问", t8.kind === "ask" && t8.questionFromModel === true && t8.question.includes("膝盖"), t8);

const t9 = judgeModelReply(knee, reply({ kind: "ask", quote: "", question: "阿姨能走 2 公里吗？全程能走多久？", other: [] }));
check("C9 模型追问里编了距离 → 换成默认问题", t9.kind === "ask" && t9.questionFromModel === false && t9.question === DEFAULT_QUESTION, t9);

const t10 = judgeModelReply("想去断桥看看", reply({ kind: "off-topic", quote: "", question: "", other: ["想去断桥看看"] }));
check("C10 没讲走路 → off-topic，默认问题，并如实说这一版只看能走多久", t10.kind === "off-topic" && t10.question === DEFAULT_QUESTION && /这一版只按/.test(t10.note ?? ""), t10);
check("C10b 其它要求逐字保留", JSON.stringify(t10.other) === JSON.stringify(["想去断桥看看"]), t10.other);

const t11 = judgeModelReply("我妈膝盖不好，想去断桥", reply({ kind: "ask", quote: "", question: "阿姨膝盖不好，全程一共能走多久？", other: ["想去断桥", "想去灵隐寺", "", 7, "想去断桥"] }));
check("C11 其它要求：编造的（灵隐寺）、空的、非字符串、重复的都丢掉", JSON.stringify(t11.other) === JSON.stringify(["想去断桥"]), t11.other);

const t12 = judgeModelReply(knee, "这不是 JSON");
check("C12 模型返回的不是 JSON → 退回默认问题，source=fallback", t12.kind === "ask" && t12.source === "fallback" && /没读成/.test(t12.note ?? ""), t12);
const t13 = judgeModelReply(knee, reply({ kind: "minutes", minutes: 30 }));
check("C13 模型返回了不认识的类别（还自带了数字）→ 退回默认问题，不采用它的数字", t13.kind === "ask" && t13.minutes === null && t13.source === "fallback", t13);
const t14 = judgeModelReply(knee, reply(["total"]));
check("C14 模型返回数组而不是对象 → 退回默认问题", t14.source === "fallback");
const t15 = judgeModelReply("我妈全程最多走１小时", reply({ kind: "total", quote: "全程最多走1小时", question: "", other: [] }));
check("C15 全角/半角数字差异不影响逐字核对", t15.kind === "minutes" && t15.minutes === 60, t15);

/* C16+. T2 新增：一口气 + 全程并存、年龄数字、口语化的全程说法 */
const t16 = judgeModelReply("走半小时就累，但全程加起来一个半小时没问题", reply({ kind: "total", quote: "全程加起来一个半小时没问题", question: "", other: [] }));
check("C16 一口气 + 全程并存：按全程那一段定为 90 分钟", t16.kind === "minutes" && t16.minutes === 90, t16);
const t17 = judgeModelReply("走半小时就累，但全程加起来一个半小时没问题", reply({ kind: "total", quote: "走半小时就累", question: "", other: [] }));
check("C17 同一句里模型摘错成一口气那段 → 代码拦下改为追问", t17.kind === "ask" && t17.minutes === null && /一口气/.test(t17.note ?? ""), t17);
const t18 = judgeModelReply("我妈说走一个小时没问题，但要经常坐下来歇歇", reply({ kind: "total", quote: "走一个小时没问题", question: "", other: [] }));
check("C18 「歇歇」在另一小句里，不影响这一小句的全程时长 → 60 分钟", t18.kind === "minutes" && t18.minutes === 60, t18);
const t19 = judgeModelReply("老人家七十多了", reply({ kind: "total", quote: "七十多", question: "", other: [] }));
check("C19 年龄数字被当成时长 → 代码算不出分钟，改为追问", t19.kind === "ask" && t19.minutes === null, t19);
const t20 = judgeModelReply("带着八十岁的奶奶", reply({ kind: "ask", quote: "", question: "奶奶八十岁了，全程一共大概能走多久？", other: [] }));
check("C20 追问里复述年龄（不是时长或距离）允许", t20.kind === "ask" && t20.questionFromModel === true, t20);
const t21 = judgeModelReply("我妈一共能走四十分钟左右", reply({ kind: "total", quote: "一共能走四十分钟左右", question: "", other: [] }));
check("C21 「四十分钟左右」按用户说的 40 分钟（「左右」不算含糊范围）", t21.kind === "minutes" && t21.minutes === 40, t21);
const t22 = judgeModelReply("半天都行吧", reply({ kind: "total", quote: "半天都行", question: "", other: [] }));
check("C22 「半天」不是步行时长 → 不换算，追问", t22.kind === "ask" && t22.minutes === null, t22);
const t23 = judgeModelReply("全程走路控制在一小时以内", reply({ kind: "total", quote: "全程走路控制在一小时以内", question: "", other: [] }));
check("C23 「一小时以内」→ 60 分钟", t23.kind === "minutes" && t23.minutes === 60, t23);
const extraDurations = [["四十五分钟", 45], ["两个小时没问题", 120], ["一小时以内", 60], ["四十分钟左右", 40], ["七十多", null], ["八十岁", null], ["半天都行", null], ["二十分钟要歇一下", 20]];
const extraFails = extraDurations.map(([input, expected]) => ({ input, expected, actual: parseDurationMinutes(input) })).filter((row) => row.actual !== row.expected);
check(`C24 新增 ${extraDurations.length} 例时长换算符合期望`, extraFails.length === 0, extraFails);
check("C25 系统提示写了「一口气 + 全程并存时按全程」与「年龄不算时长」", UNDERSTAND_SYSTEM_PROMPT.includes("同时有一口气走多久和全程走多久") && UNDERSTAND_SYSTEM_PROMPT.includes("年龄"));

/* C26+. 真实 40 句探针里暴露的两类问题，改在代码里确定性处理（模型回复按探针记录手写） */
check("B10 追问没问到「全程」（探针原句：一两个小时应该能走多久？）→ 作废", safeQuestion("一两个小时应该能走多久？", "一两个小时应该可以") === null);
const t26 = judgeModelReply("带着八十岁的奶奶", reply({ kind: "off-topic", quote: "", question: "", other: ["带着八十岁的奶奶"] }));
check("C26 讲的是老人年龄却被判 off-topic → 改为追问，不说「这一版还用不上」", t26.kind === "ask" && t26.question === DEFAULT_QUESTION && t26.other.length === 0 && t26.note === null, t26);
const t27 = judgeModelReply("老人家七十多了", reply({ kind: "off-topic", quote: "", question: "", other: [] }));
check("C27 「老人家七十多了」被判 off-topic → 改为追问", t27.kind === "ask" && t27.minutes === null, t27);
const t28 = judgeModelReply("我妈膝盖不好，想去河坊街", reply({ kind: "ask", quote: "", question: "阿姨膝盖不好，全程一共能走多久？", other: ["我妈膝盖不好", "想去河坊街"] }));
check("C28 「其它要求」里讲老人身体的那条不列进「用不上」，真正的其它要求保留", JSON.stringify(t28.other) === JSON.stringify(["想去河坊街"]), t28.other);
const t29 = judgeModelReply("中午想找个地方吃饭", reply({ kind: "off-topic", quote: "", question: "", other: ["中午想找个地方吃饭"] }));
check("C29 真正没讲走路的仍是 off-topic", t29.kind === "off-topic" && JSON.stringify(t29.other) === JSON.stringify(["中午想找个地方吃饭"]), t29);

check("D1 系统提示含 JSON 字样（百炼 json_object 模式的硬性要求）", /JSON/.test(UNDERSTAND_SYSTEM_PROMPT));
check("D2 系统提示明确写了「一口气不是全程」与「不要给出任何数字」", UNDERSTAND_SYSTEM_PROMPT.includes("一口气") && UNDERSTAND_SYSTEM_PROMPT.includes("不要自己给出任何数字"));

/* ═════ E. 服务端调用链路（fetch 桩 + 假密钥） ═════ */
delete process.env.DASHSCOPE_API_KEY;
delete process.env.BAILIAN_WORKSPACE_ID;
delete process.env.BAILIAN_UNDERSTAND_MODEL;
const server = await import("../src/lib/server/understand.ts");

const before0 = outbound.length;
const notConfigured = await server.understandText(knee);
check("E1 没配置时不发请求、0 次调用、退回默认问题并说明原因", outbound.length === before0 && notConfigured.degraded && notConfigured.cost.modelCalls === 0 && /配置不完整/.test(notConfigured.understanding.note ?? ""), notConfigured);
check("E1b 错误里写明缺哪个变量（只有变量名，没有值）", /DASHSCOPE_API_KEY/.test(notConfigured.error ?? "") && /BAILIAN_WORKSPACE_ID/.test(notConfigured.error ?? ""), notConfigured.error);

process.env.DASHSCOPE_API_KEY = FAKE_KEY;
process.env.BAILIAN_WORKSPACE_ID = FAKE_WS;
mode = { kind: "reply", content: reply({ kind: "ask", quote: "", question: "阿姨膝盖不好，全程一共大概能走多久？", other: [] }) };
const ok = await server.understandText(knee);
const sent = outbound.at(-1);
check("E2 正常：恰好 1 次请求，结论是追问", outbound.length === before0 + 1 && ok.understanding.kind === "ask" && ok.understanding.questionFromModel && !ok.degraded, ok.understanding);
check("E2b 打到本工作空间北京地域的 OpenAI 兼容接口", sent.url === `https://${FAKE_WS}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`, sent.url);
check("E2c 强制 json_object、关思考、temperature 0、默认模型 qwen-flash", sent.body.response_format?.type === "json_object" && sent.body.enable_thinking === false && sent.body.temperature === 0 && sent.body.model === "qwen-flash", { rf: sent.body.response_format, think: sent.body.enable_thinking, t: sent.body.temperature, model: sent.body.model });
check("E2d 用户原话原样作为 user 消息，系统提示是同一份", sent.body.messages[1].content === knee && sent.body.messages[0].content === UNDERSTAND_SYSTEM_PROMPT);
check("E2e 带了鉴权头", sent.headers.Authorization === `Bearer ${FAKE_KEY}`);
check("E2f 如实回报 1 次调用与 token 数", ok.cost.modelCalls === 1 && ok.cost.inputTokens === 420 && ok.cost.outputTokens === 30, ok.cost);
check("E2g 返回给前端的内容里没有密钥和工作空间 ID", !JSON.stringify(ok).includes(FAKE_KEY) && !JSON.stringify(ok).includes(FAKE_WS));

process.env.BAILIAN_UNDERSTAND_MODEL = "qwen3.8-flash";
await server.understandText(knee);
check("E3 BAILIAN_UNDERSTAND_MODEL 可以换模型", outbound.at(-1).body.model === "qwen3.8-flash", outbound.at(-1).body.model);
delete process.env.BAILIAN_UNDERSTAND_MODEL;

mode = { kind: "http", status: 401, code: "InvalidApiKey" };
const unauthorized = await server.understandText(knee);
check("E4 百炼 401 → 退回默认问题，如实写状态码，仍记 1 次调用", unauthorized.degraded && unauthorized.cost.modelCalls === 1 && /401/.test(unauthorized.error ?? "") && unauthorized.understanding.question === DEFAULT_QUESTION, { error: unauthorized.error, cost: unauthorized.cost });
check("E4b 错误信息里没有密钥", !JSON.stringify(unauthorized).includes(FAKE_KEY));

mode = { kind: "throw" };
const network = await server.understandText(knee);
check("E5 网络错误 → 退回默认问题并说连不上", network.degraded && /连不上百炼/.test(network.understanding.note ?? ""), network.understanding.note);

mode = { kind: "garbage" };
const garbage = await server.understandText(knee);
check("E6 百炼返回非 JSON → 退回默认问题", garbage.degraded && garbage.understanding.source === "fallback");

mode = { kind: "reply", content: "我觉得大概一小时吧" };
const prose = await server.understandText(knee);
check("E7 模型回了一段话而不是 JSON → degraded，不从里面捞数字", prose.degraded && prose.understanding.minutes === null && prose.understanding.kind === "ask", prose.understanding);

const status = server.understandStatus();
check("E8 状态里有调用计数，日志里没有用户原话", status.modelCalls >= 5 && !JSON.stringify(status.log).includes("膝盖"), { modelCalls: status.modelCalls, failed: status.failedCalls });

/* 小时上限：用满之后不再发请求 */
mode = { kind: "reply", content: reply({ kind: "ask", quote: "", question: "全程一共能走多久？", other: [] }) };
while (server.understandStatus().callsLastHour < server.UNDERSTAND_HOURLY_CAP) await server.understandText(knee);
const beforeCap = outbound.length;
const capped = await server.understandText(knee);
check(`E9 本小时用满 ${server.UNDERSTAND_HOURLY_CAP} 次后拒绝，不发请求、不计调用`, outbound.length === beforeCap && capped.degraded && capped.cost.modelCalls === 0 && /上限/.test(capped.error ?? ""), { error: capped.error, cost: capped.cost });

/* ═════ F. 路由：参数校验 ═════ */
const route = await import("../src/app/api/understand/route.ts");
const post = async (body) => {
  const response = await route.POST(new Request("http://localhost/api/understand", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  return { status: response.status, json: await response.json() };
};
const beforeRoute = outbound.length;
for (const [label, body] of [["缺 text", {}], ["数字", { text: 5 }], ["空白", { text: "   " }], ["超长", { text: "膝".repeat(201) }], ["坏 JSON", "{"]]) {
  const res = await post(body);
  check(`F1 非法输入（${label}）返回 4xx，不发请求`, res.status >= 400 && res.status < 500, { status: res.status, error: res.json.error });
}
check("F1b 上述非法输入一次请求都没发", outbound.length === beforeRoute, { sent: outbound.length - beforeRoute });
const statusRes = await route.GET();
const statusJson = await statusRes.json();
check("F2 GET 返回状态且不含密钥", statusRes.status === 200 && statusJson.configured === true && statusJson.model === "qwen-flash" && !JSON.stringify(statusJson).includes(FAKE_KEY));

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} 读一句话零付费检查通过（fetch 桩 + 假密钥，零真实调用）`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
