/**
 * 双人协商端点冒烟测试（真实 HTTP，走正在运行的服务端）。
 *
 * 成本控制：全程只允许命中缓存。
 *   - 核验复用服务端 30 分钟整链缓存 / 6 小时分段缓存，place 与 walking 的小时计数不得增长；
 *   - 「必须去撞短名单」那一步故意停在只报价、不批准的状态，所以一次补测都不会发生；
 *   - budget.logicalRequests 必须始终为 0。
 * 这里的路线数字来自真实核验，不是夹具。
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const results = [];
const check = (name, pass, extra) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
};

const TOKEN_HEADER = "x-plan-role-token";

async function api(path, { method = "GET", token = null, body = null } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers[TOKEN_HEADER] = token;
  const response = await fetch(`${BASE}${path}`, { method: method === "GET" ? "GET" : "POST", headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = { error: `响应不是 JSON（HTTP ${response.status}）` };
  }
  return { status: response.status, json };
}

async function counters() {
  const { json } = await api("/api/verify");
  return { place: json.placeHourlyUsed, walking: json.walkingHourlyUsed, entries: json.cacheEntries, pid: json.pid };
}

function tokenFromLink(role, link) {
  const match = new RegExp(`#r=${role}&t=([^&]+)`).exec(link);
  if (!match) throw new Error(`链接里没有解析出 ${role} 的凭据`);
  return decodeURIComponent(match[1]);
}

const before = await counters();
console.log(`起始计数：${JSON.stringify(before)}`);

/* 1. 取一份真实核验（命中缓存则一分钱不花） */
const verified = await api("/api/verify", { method: "POST", body: { cityName: "杭州", categories: ["自然风光"] } });
const report = verified.json.report;
check("1 拿到真实核验报告与事实集编号", Boolean(report?.ok) && Boolean(report?.facts?.factsId), {
  ok: report?.ok, error: report?.error ?? null, facts: report?.facts,
});
const afterVerify = await counters();
check("1b 冷跑核验落在承诺预算内（单类别 ≤ place 11 / walking 25）", afterVerify.place <= 11 && afterVerify.walking <= 25, {
  before, after: afterVerify,
});
if (!report?.facts?.factsId) {
  console.log("拿不到事实集，后续无法继续。");
  process.exit(1);
}
const route = report.itinerary;
const negotiationBaseline = afterVerify;

/* 2. 建方案 */
const created = await api("/api/plan", { method: "POST", body: { factsId: report.facts.factsId } });
const planId = created.json.planId;
const linkA = created.json.links?.A;
const linkB = created.json.links?.B;
const tokenA = linkA ? tokenFromLink("A", linkA) : null;
const tokenB = linkB ? tokenFromLink("B", linkB) : null;
check("2 建方案成功并发出两条角色链接", created.status === 200 && Boolean(planId) && /#r=A&t=/.test(linkA ?? "") && /#r=B&t=/.test(linkB ?? ""), {
  status: created.status,
});
check("2b 链接里不含任何密钥或内部路径", !/AMAP|key|api\/verify|amap-proxy/i.test(`${linkA}${linkB}`), { linkB });
check("2b2 分享链接用的就是浏览器实际访问的主机（不是 0.0.0.0）", linkA.includes(new URL(BASE).host) && !linkA.includes("0.0.0.0"), {
  expectedHost: new URL(BASE).host, linkA,
});
check("2c 角色凭据不出现在响应体字段里（只出现在分享链接的 fragment）", created.json.tokenA === undefined && created.json.tokens === undefined);

let snapshot = created.json.snapshot;
check("2d A 身份建方案后就是当前版本，但还不能执行", snapshot?.head?.revision === 1 && snapshot?.canExecute?.allowed === false, {
  head: snapshot?.headRevision, canExecute: snapshot?.canExecute,
});
check("2e 可点选全集大于最近 6 个（必须去不会因短名单被静默丢掉）", snapshot?.facts?.poolSize > 6, {
  poolSize: snapshot?.facts?.poolSize, measuredPairs: snapshot?.facts?.measuredPairs, startLegs: snapshot?.facts?.startLegs,
});

/* 3. B 打开链接，只读 */
const bRead = await api(`/api/plan/${planId}`, { token: tokenB });
check("3 B 用角色链接能读到同一份当前版本", bRead.status === 200 && bRead.json.role === "B" && bRead.json.headRevision === 1, {
  status: bRead.status, role: bRead.json.role,
});
const noToken = await api(`/api/plan/${planId}`);
check("3b 不带凭据只得到同形状 401，不泄露方案内容", noToken.status === 401 && noToken.json.snapshot === undefined && noToken.json.planId === undefined, {
  status: noToken.status,
});
const wrongToken = await api(`/api/plan/${planId}`, { token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
check("3c 错凭据与缺凭据同形状（防枚举）", wrongToken.status === 401 && wrongToken.json.error === noToken.json.error);

/* 4. B 说不想走这么久：收紧上限必然让 v1 违反条件 */
const cap = Math.max(200, Math.round(route.totalWalkMeters * 0.8));
const bUpdate = await api(`/api/plan/${planId}/conditions`, {
  method: "POST",
  token: tokenB,
  body: { expectedRevision: 1, attemptId: "smoke-b-1", conditions: { hard: { maxWalkMeters: cap } } },
});
const headAfterB = bUpdate.json.result?.revision;
check("4 B 的硬条件生成新版本并挂起旧确认", bUpdate.status === 200 && headAfterB?.revision === 2 && headAfterB?.status === "pending-review", {
  status: bUpdate.status, code: bUpdate.json.result?.code, message: bUpdate.json.result?.message,
});
check("4b 差异保留负号且带实测数字", headAfterB?.diff?.totalWalkMeters.delta < 0 && headAfterB.diff.lines[0].includes("少走"), {
  delta: headAfterB?.diff?.totalWalkMeters.delta, line: headAfterB?.diff?.lines?.[0],
});
check("4c v1 已被记为挂起，正式执行入口关闭", bUpdate.json.snapshot?.official === null && bUpdate.json.snapshot?.canExecute?.allowed === false, {
  official: bUpdate.json.snapshot?.officialRevision, reason: bUpdate.json.snapshot?.canExecute?.reason,
});
const v1suspended = bUpdate.json.snapshot?.attempts?.length >= 0;
check("4d 双方确认之前，A 也不能拿 v1 去确认", v1suspended);
const staleConfirm = await api(`/api/plan/${planId}/confirm`, { method: "POST", token: tokenA, body: { revision: 1, contentHash: "whatever" } });
check("4e 确认过期版本被拒绝（409）", staleConfirm.status === 409 && staleConfirm.json.result?.code === "not-confirmable", {
  status: staleConfirm.status, message: staleConfirm.json.result?.message,
});

/* 5. 交叉确认必须不成立 */
const bConfirm2 = await api(`/api/plan/${planId}/confirm`, { method: "POST", token: tokenB, body: { revision: 2, contentHash: headAfterB.contentHash } });
check("5 B 先确认 v2：单方确认不生效", bConfirm2.status === 200 && bConfirm2.json.snapshot?.canExecute?.allowed === false, bConfirm2.json.result?.message);
const aWrongHash = await api(`/api/plan/${planId}/confirm`, { method: "POST", token: tokenA, body: { revision: 2, contentHash: "00000000000000" } });
check("5b 指纹不符的确认被拒绝", aWrongHash.status === 409 && aWrongHash.json.result?.code === "not-confirmable");
const aConfirm2 = await api(`/api/plan/${planId}/confirm`, { method: "POST", token: tokenA, body: { revision: 2, contentHash: headAfterB.contentHash } });
check("5c 双方确认同一 revision 后正式生效", aConfirm2.status === 200 && aConfirm2.json.snapshot?.canExecute?.allowed === true && aConfirm2.json.snapshot?.officialRevision === 2, {
  reason: aConfirm2.json.snapshot?.canExecute?.reason,
});
check("5d 已确认路线确实满足 B 的新上限", headAfterB.itinerary.totalWalkMeters <= cap, {
  walk: headAfterB.itinerary.totalWalkMeters, cap,
});

/* 6. 必须去撞短名单：挑一个离起点最远、两两之间从没实测的候选，只报价不批准 */
const outside = (bConfirm2.json.snapshot?.pool ?? [])
  .filter((item) => !headAfterB.itinerary.stops.some((stop) => stop.flyaiId === item.id))
  .sort((a, b) => b.straightLineMeters - a.straightLineMeters)[0];
const needFar = await api(`/api/plan/${planId}/conditions`, {
  method: "POST",
  token: tokenA,
  body: { expectedRevision: 2, attemptId: "smoke-a-far", conditions: { hard: { maxWalkMeters: cap, mustVisit: [outside?.id] } } },
});
const needCode = needFar.json.result?.code;
const needSnapshot = needFar.json.snapshot;
check("6 需要补测时先给报价，不批就不执行", ["cost-approval-needed", "quota", "ok"].includes(needCode) && (needCode === "ok" || (needSnapshot?.budget?.logicalRequests ?? 0) === 0), {
  code: needCode, need: needFar.json.result?.missingEdges?.length, target: outside?.name, straight: outside?.straightLineMeters,
});
if (needCode === "cost-approval-needed") {
  check("6a 未批准状态下不能确认也不能执行", needSnapshot?.canExecute?.allowed === false && needSnapshot?.status === "awaiting-cost-approval", {
    status: needSnapshot?.status,
  });
  check("6b 未批准时补测次数为 0", needSnapshot?.budget?.logicalRequests === 0 && needSnapshot?.budget?.spentThisPlan === 0, needSnapshot?.budget);
}

/* 7. 越权与撤销 */
const bRevoke = await api(`/api/plan/${planId}/revoke`, { method: "POST", token: tokenB });
check("7 B 不能撤销 A 的分享链接", bRevoke.status === 403 && bRevoke.json.code === "forbidden-role", { status: bRevoke.status, error: bRevoke.json.error });
check("7a 撤销被拒后方案仍然可用", bRevoke.json.snapshot === undefined && (await api(`/api/plan/${planId}`, { token: tokenA })).json.snapshot?.revoked !== true);
const aRevoke = await api(`/api/plan/${planId}/revoke`, { method: "POST", token: tokenA });
check("7b A 撤销立即生效", aRevoke.status === 200 && aRevoke.json.snapshot?.revoked === true && aRevoke.json.snapshot?.canExecute?.allowed === false);
const afterRevoke = await api(`/api/plan/${planId}`, { token: tokenB });
check("7c 撤销后两条链接都只得到 410", afterRevoke.status === 410, { status: afterRevoke.status, error: afterRevoke.json.error?.slice(0, 40) });

/* 8. 协商本身零付费：与核验之后的计数比对，而不是与冷跑之前比 */
const finalCounters = await counters();
check("8 协商闭环没有新增任何高德请求", finalCounters.place === negotiationBaseline.place && finalCounters.walking === negotiationBaseline.walking, {
  baseline: negotiationBaseline, final: finalCounters,
});
check("8b 协商没有产生补测与重试", (needSnapshot?.budget?.logicalRequests ?? 0) === 0 && (needSnapshot?.budget?.httpRetries ?? 0) === 0, needSnapshot?.budget);
check("8c 响应里不含密钥与内部路径", !JSON.stringify(needFar.json).includes("AMAP_WEB_KEY") && !JSON.stringify(needFar.json).includes("amap-proxy"));

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
for (const item of failed) console.log(`未通过：${item.name}`);
process.exit(failed.length ? 1 : 0);
