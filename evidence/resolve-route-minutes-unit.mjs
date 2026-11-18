/**
 * /api/resolve 对 maxWalkMinutes 的接口层回归：参数校验、与米数口径并存、响应形状、0 新增高德调用。
 * 纯夹具：把夹具事实集放进本进程的事实层，直接调用路由处理函数；零真实 API 调用。
 * 跑法：node --import ./evidence/register-alias.mjs evidence/resolve-route-minutes-unit.mjs
 */
import { makeCompleteFacts } from "./negotiation-fixture.ts";

const { putFactSet } = await import("../src/lib/server/facts.ts");
const route = await import("../src/app/api/resolve/route.ts");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
};

const facts = makeCompleteFacts();
putFactSet(facts);

async function call(body) {
  const response = await route.POST(new Request("http://localhost/api/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, json: await response.json() };
}

/* 1. 正常：60 分钟放得下 4 站，响应里带分钟口径的解释 */
const ok = await call({ factsId: facts.factsId, maxWalkMinutes: 60 });
check("1 maxWalkMinutes=60 返回 200 且 ok", ok.status === 200 && ok.json.ok === true, { status: ok.status, ok: ok.json.ok, error: ok.json.error });
check("1b 响应里 constraints 回显了分钟上限", ok.json.constraints?.maxWalkMinutes === 60 && ok.json.constraints?.maxWalkMeters === null, ok.json.constraints);
check("1c explanation 带实测分钟与上限，且判定在限内", ok.json.explanation?.totalWalkMinutes === 30 && ok.json.explanation?.limitMinutes === 60 && ok.json.explanation?.withinMinutesLimit === true, ok.json.explanation && { total: ok.json.explanation.totalWalkMinutes, limit: ok.json.explanation.limitMinutes });
check("1d 响应声明本次新增高德调用 0 次", ok.json.cost?.newAmapCalls === 0, ok.json.cost);
check("1e 执行门禁放行并写明分钟", ok.json.execution?.allowed === true && /不超你定的 60 分钟/.test(ok.json.execution.reason), ok.json.execution?.reason);

/* 2. 收紧：20 分钟只能排 3 站 */
const tight = await call({ factsId: facts.factsId, maxWalkMinutes: 20 });
check("2 maxWalkMinutes=20 排 3 站且步行 ≤ 20 分钟", tight.json.ok === true && tight.json.itinerary.stops.length === 3 && tight.json.itinerary.totalWalkMinutes <= 20, tight.json.ok ? { stops: tight.json.itinerary.stops.length, minutes: tight.json.itinerary.totalWalkMinutes } : tight.json.reason);

/* 3. 不确定 / 不传：null 与缺省等价，都是不设上限 */
const nullCap = await call({ factsId: facts.factsId, maxWalkMinutes: null });
const omitted = await call({ factsId: facts.factsId });
check("3 maxWalkMinutes=null 与不传结果一致（不设上限）", nullCap.json.ok === true && omitted.json.ok === true && nullCap.json.explanation.verdict === omitted.json.explanation.verdict && nullCap.json.explanation.limitMinutes === null);

/* 4. 排不出：200 + ok:false，建议值是分钟口径，且带 0 新增调用 */
const impossible = await call({ factsId: facts.factsId, maxWalkMinutes: 5 });
check("4 maxWalkMinutes=5 返回 ok:false 与 no-solution", impossible.status === 200 && impossible.json.ok === false && impossible.json.code === "no-solution", { status: impossible.status, code: impossible.json.code });
check("4b 建议值：至少 10 分钟排 2 站", impossible.json.suggestion?.maxWalkMinutes === 10 && impossible.json.suggestion?.stopCount === 2, impossible.json.suggestion);
check("4c 失败响应同样声明 0 新增调用", impossible.json.cost?.newAmapCalls === 0, impossible.json.cost);

/* 5. 参数校验：非法值一律 400 + constraint-invalid，且点名 maxWalkMinutes，不静默当成不设限 */
for (const [label, value] of [["小数", 12.5], ["字符串", "30"], ["低于下限 4", 4], ["高于上限 241", 241], ["负数", -10], ["布尔", true]]) {
  const bad = await call({ factsId: facts.factsId, maxWalkMinutes: value });
  check(`5 非法值（${label}）被 400 拒绝并点名 maxWalkMinutes`, bad.status === 400 && bad.json.code === "constraint-invalid" && /maxWalkMinutes/.test(bad.json.error), { status: bad.status, error: bad.json.error });
}
const lower = await call({ factsId: facts.factsId, maxWalkMinutes: 5 });
const upper = await call({ factsId: facts.factsId, maxWalkMinutes: 240 });
check("5b 边界值 5 与 240 被接受（不是 400）", lower.status === 200 && upper.status === 200 && upper.json.ok === true, { lower: lower.status, upper: upper.status });

/* 6. 旧口径仍可用：米数上限、单段上限（真实验收脚本与以后重新露出单段时使用） */
const meters = await call({ factsId: facts.factsId, maxWalkMeters: 1200 });
check("6 maxWalkMeters 仍然工作且 constraints 里分钟为 null", meters.json.ok === true && meters.json.constraints?.maxWalkMinutes === null && meters.json.itinerary.totalWalkMeters <= 1200, meters.json.ok ? meters.json.itinerary.totalWalkMeters : meters.json.reason);
const segment = await call({ factsId: facts.factsId, maxSegmentMeters: 1500 });
check("6b maxSegmentMeters 仍然工作", segment.json.ok === true && segment.json.explanation.segmentLimit === 1500, segment.json.ok ? segment.json.explanation.segmentLimit : segment.json.reason);

/* 7. 分钟与米数可同时设：两个口径各自独立判定（取更严的） */
const both = await call({ factsId: facts.factsId, maxWalkMinutes: 60, maxWalkMeters: 1200 });
check("7 分钟 60 + 米数 1200 同时设：行程同时满足两者", both.json.ok === true && both.json.itinerary.totalWalkMinutes <= 60 && both.json.itinerary.totalWalkMeters <= 1200, both.json.ok ? { m: both.json.itinerary.totalWalkMeters, min: both.json.itinerary.totalWalkMinutes } : both.json.reason);

/* 7b. 每站停留（D2）：只接受 15/30/45/60，不传就是 30 */
const stayDefault = await call({ factsId: facts.factsId });
check("7b 不传 stayMinutes 时回显 30，且每站停留 30", stayDefault.json.ok === true && stayDefault.json.constraints?.stayMinutes === 30 && stayDefault.json.itinerary.stops.every((s) => s.stayMinutes === 30), stayDefault.json.constraints);
const stay60 = await call({ factsId: facts.factsId, stayMinutes: 60 });
check("7c stayMinutes=60：3 站、合计 218、带停留说明，0 新增高德调用", stay60.json.ok === true && stay60.json.itinerary.stops.length === 3 && stay60.json.itinerary.totalMinutes === 218 && typeof stay60.json.explanation?.stayNote === "string" && stay60.json.cost?.newAmapCalls === 0, stay60.json.ok ? { stops: stay60.json.itinerary.stops.length, total: stay60.json.itinerary.totalMinutes, note: stay60.json.explanation.stayNote } : stay60.json);
const afterStay = await call({ factsId: facts.factsId });
check("7d 按 60 分钟解完后，同一份事实集再按默认解仍是 30（服务端缓存没被改）", afterStay.json.ok === true && afterStay.json.itinerary.stops.every((s) => s.stayMinutes === 30));
for (const [label, value] of [["不在菜单里的 20", 20], ["字符串", "30"], ["0", 0], ["小数", 30.5], ["90", 90]]) {
  const bad = await call({ factsId: facts.factsId, stayMinutes: value });
  check(`7e 非法 stayMinutes（${label}）被 400 拒绝并点名`, bad.status === 400 && bad.json.code === "constraint-invalid" && /stayMinutes/.test(bad.json.error), { status: bad.status, error: bad.json.error });
}
const stayNull = await call({ factsId: facts.factsId, stayMinutes: null });
check("7f stayMinutes=null 等于不传（30）", stayNull.json.ok === true && stayNull.json.constraints?.stayMinutes === 30);

/* 8. 事实集不存在：仍是 410，不自动重跑付费核验 */
const gone = await call({ factsId: "no-such-facts", maxWalkMinutes: 30 });
check("8 事实集不存在返回 410 facts-unavailable", gone.status === 410 && gone.json.code === "facts-unavailable", { status: gone.status, code: gone.json.code });

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} resolve 路由分钟口径检查通过（夹具事实集，零真实调用）`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
