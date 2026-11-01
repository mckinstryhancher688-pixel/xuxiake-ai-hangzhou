import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xuxiake-trips-"));
process.env.TRIP_DATA_DIR = directory;
process.env.TRIPS_ENABLED = "1";
process.env.TRIPS_WORKER_PAUSED = "1";
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("Offline acceptance forbids all network requests"); };
const storage = await import("../src/lib/server/trips/db.ts");
const store = await import("../src/lib/server/trips/store.ts");
const routing = await import("../src/lib/server/trips/routing.ts");
const knowledge = await import("../src/lib/server/trips/knowledge.ts");
const retrieval = await import("../src/lib/trips/retrieval.ts");
const { emptyConditions } = await import("../src/lib/negotiation/types.ts");
const { stopIdOf } = await import("../src/lib/types.ts");
const { explanationIssue } = await import("../src/lib/trips/explanation.ts");
const { compareVerifiedPoiPairs } = await import("../src/lib/server/verify.ts");
const api = await import("../src/app/api/trips/[[...path]]/route.ts");
let passed = 0;
function check(name, work) { work(); passed++; console.log("PASS " + name); }
async function checkAsync(name, work) { await work(); passed++; console.log("PASS " + name); }
const created = store.createTrip("离线夹具：邀请与路线");
const tripId = created.trip.id, aToken = created.token;
function current() { return storage.loadTrip(tripId); }
function currentVersion() { return current().version; }
check("创建即有A，没有路线和B，且不联网", () => {
  assert.equal(store.authorizeTrip(tripId, aToken), "A");
  assert.equal(current().members.B, null); assert.equal(current().plan, null); assert.equal(networkCalls, 0);
});
check("伪造角色凭据不能读取空间", () => assert.throws(() => store.authorizeTrip(tripId, "fake"), /凭据/));
const first = store.createInvitation(tripId, "A", currentVersion());
check("预览邀请不加入", () => {
  assert.equal(store.previewInvitation(tripId, first.invite).city, "杭州");
  assert.equal(current().members.B, null);
});
store.createInvitation(tripId, "A", currentVersion());
check("重发邀请使旧链接失效", () => assert.throws(() => store.previewInvitation(tripId, first.invite), /邀请/));
store.revokeInvitation(tripId, "A", currentVersion());

const providers = {
  async extract(_trip, text) {
    return { text, mentions: text.split("\n").filter((s) => s.includes("：")).map((line) => ({
      name: line.split("：")[0], reason: line.split("：")[1], quote: line, stance: line.includes("不推荐") ? "avoid" : "recommend",
    })) };
  },
  async embed(_trip, texts) { return texts.map((text) => { const vector = Array(512).fill(0); vector[text.includes("静") ? 1 : 0] = 1; return vector; }); },
  async answer(_trip, _role, _question, chunks) { return { answer: "资料中有相关描述，请核对原文。", citations: chunks.map((c) => c.id) }; },
};
async function ingest(owner, text, target = tripId) {
  const trip = storage.loadTrip(target);
  const materialId = store.addMaterial(target, owner, trip.version, { title: "人工标注测试攻略", text, sourceUrl: null });
  const job = storage.jobsFor(target).find((j) => j.input.materialId === materialId);
  storage.updateJob(job.id, "processing");
  const result = await knowledge.processMaterial(job, providers);
  storage.updateJob(job.id, "ready", result);
  return materialId;
}
const materialId = await ingest("A", "静巷：人少安静，适合独处。\n湖亭：傍晚夕阳适合摄影。");
check("资料形成出处、片段、语义向量和未核验候选", () => {
  const m = current().materials[0];
  assert.equal(m.status, "ready"); assert.equal(m.chunks[0].vector.length, 512);
  assert.equal(current().candidates.length, 2);
  assert.equal(current().candidates[0].identity, "pending");
});
check("相同资料同一人不能重复上传", () => assert.throws(() => store.addMaterial(tripId, "A", currentVersion(),
  { title: "", text: "静巷：人少安静，适合独处。\n湖亭：傍晚夕阳适合摄影。", sourceUrl: null }), /相同/));
check("更新资料版本冲突被拒绝", () => assert.throws(() => store.changeMaterial(tripId, "A", materialId, 0, "新文字"), /更新/));
check("无效图片签名被拒绝", () => assert.throws(() => store.addMaterial(tripId, "A", currentVersion(),
  { title: "坏图", text: "", sourceUrl: null, image: { buffer: Buffer.from("not-image"), mime: "image/png" } }), /图片/));
check("只有HTTP来源链接可保存，不抓取其内容", () => assert.throws(() => store.addMaterial(tripId, "A", currentVersion(),
  { title: "", text: "文字", sourceUrl: "file:///private" }), /链接/));
const conditions = emptyConditions("A");
conditions.bias = "see_more";
store.saveConditions(tripId, "A", conditions, currentVersion());
for (const candidate of current().candidates) routing.editCandidate(tripId, candidate.id, currentVersion(), { selected: true });
const pois = {
  "湖滨公园": { id: "start", name: "湖滨公园", position: { lat: 30.25, lng: 120.15 } },
  "静巷": { id: "a1", name: "静巷", position: { lat: 30.26, lng: 120.16 } },
  "湖亭": { id: "a2", name: "湖亭", position: { lat: 30.27, lng: 120.17 } },
};
let places = 0, walks = 0;
function entry(api) { return { at: new Date().toISOString(), api, fromCache: false, retries: 0, params: "", httpStatus: 200, infocode: "10000", info: "OK", durationMs: 0, error: null }; }
const routes = {
  async place(name) { places++; const poi = pois[name]; return { ok: true, data: poi ? [{ ...poi, address: "杭州测试夹具地址", adname: "上城区", typecode: "110000", opentime: "00:00-24:00", rating: null }] : [], error: null, entry: entry("place/text") }; },
  async walk(from, to) { walks++; const distanceMeters = from.lat === 30.25 ? 3000 : 4000;
    return { ok: true, data: { distanceMeters, durationSeconds: distanceMeters / 1.2, polyline: [from, to], stepCount: 1, firstInstruction: "测试夹具，不是高德真实数据" }, error: null, entry: entry("direction/walking") }; },
};
function verifyJob(quote) { return { id: "manual-job", tripId, owner: "A", kind: "verify", status: "pending", input: { quoteId: quote.id, approveCost: true }, result: null, error: null, requestKey: "test-verify", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }
const quote = routing.makeQuote(tripId, currentVersion());
check("两候选首轮上界4条有向步行段", () => assert.equal(quote.walkingUpperBound, 4));
await routing.verifyTrip(verifyJob(quote), routes);
check("高德独立核验地点不伪造飞猪ID", () => {
  const head = current().plan.revisions.at(-1);
  assert.equal(head.itinerary.stops.length, 2); assert.equal(head.itinerary.totalWalkMeters, 7000);
  assert.equal(head.itinerary.stops[0].flyaiId, null); assert.ok(stopIdOf(head.itinerary.stops[0]));
  assert.equal(walks, 4); assert.equal(places, 3);
});
let head = current().plan.revisions.at(-1);
store.confirmTrip(tripId, "A", head.revision, head.contentHash, currentVersion());
check("仅A的个人阶段可以确认执行", () => assert.equal(store.execution(current()).allowed, true));
const pending = store.createInvitation(tripId, "A", currentVersion());
check("发送邀请不暂停已确认的个人路线", () => assert.equal(store.execution(current()).allowed, true));
const b = store.joinTrip(tripId, pending.invite);
check("明确加入原子占用B，旧个人确认立即失效", () => {
  assert.equal(store.authorizeTrip(tripId, b.token), "B");
  assert.equal(store.execution(current()).allowed, false);
  assert.equal(current().plan.requiredConfirmers.join(""), "AB");
  assert.equal(current().plan.revisions.at(-1).confirmations.A, null);
});
check("重复认领不会产生第三位成员", () => assert.throws(() => store.joinTrip(tripId, pending.invite), /邀请/));
check("B不能生成邀请", () => assert.throws(() => store.createInvitation(tripId, "B", currentVersion()), /发起人/));
check("B不能修改A的原文", () => assert.throws(() => store.changeMaterial(tripId, "B", materialId, currentVersion(), "替对方修改"), /自己/));
check("B未表态时不能把A确认包装成双方同意", () => {
  const h = current().plan.revisions.at(-1);
  assert.throws(() => store.confirmTrip(tripId, "A", h.revision, h.contentHash, currentVersion()), /条件/);
});
const bConditions = emptyConditions("B"); bConditions.hard.maxWalkMeters = 6000;
const beforeCalls = walks;
store.saveConditions(tripId, "B", bConditions, currentVersion());
head = current().plan.revisions.at(-1);
check("6公里约束使7000米夹具路线变为3000米，且零新增测量", () => {
  assert.equal(head.itinerary.totalWalkMeters, 3000); assert.equal(walks, beforeCalls);
  assert.ok(head.diff.lines.some((s) => s.includes("少走")));
});
check("旧版本不能确认", () => assert.throws(() => store.confirmTrip(tripId, "A", 1, "old", currentVersion()), /版本/));
store.confirmTrip(tripId, "A", head.revision, head.contentHash, currentVersion());
check("双人阶段单方确认不能执行", () => assert.equal(store.execution(current()).allowed, false));
store.confirmTrip(tripId, "B", head.revision, head.contentHash, currentVersion());
check("同版本双方确认后才能执行", () => assert.equal(store.execution(current()).allowed, true));
check("重复提交完全相同的条件不重建路线或清空确认", () => {
  const revision = current().plan.headRevision;
  store.saveConditions(tripId, "B", bConditions, currentVersion());
  assert.equal(current().plan.headRevision, revision); assert.equal(store.execution(current()).allowed, true);
});
const same = await ingest("B", "静巷：人少安静，适合独处。\n湖亭：傍晚夕阳适合摄影。");
check("相同攻略由两人上传仍只算一份独立来源", () => {
  const candidate = current().candidates[0];
  assert.equal(knowledge.independentSourceCount(current().materials, candidate.materialIds), 1);
});
const readyRevision = current().plan.headRevision;
store.changeMaterial(tripId, "A", materialId, currentVersion(), null);
check("删除资料不重写已采用路线或确认", () => {
  assert.equal(current().plan.headRevision, readyRevision); assert.equal(store.execution(current()).allowed, true);
});
const qaJob = { ...verifyJob(quote), kind: "ask", owner: "B", input: { question: "哪里适合安静独处" } };
const answer = await knowledge.answerQuestion(qaJob, providers);
check("问答引用仅限仍存在且有权限的来源", () => {
  assert.equal(answer.retrievalMode, "hybrid"); assert.ok(answer.citations.length);
  assert.ok(answer.citations.every((c) => c.materialId === same));
});
check("空索引不编造答案", () => assert.deepEqual(retrieval.retrieve([], "虚构地点", null), []));
check("超范围候选不能静默截断", () => {
  const other = store.createTrip("候选边界");
  storage.mutate(other.trip.id, (t) => { for (let i = 0; i < 7; i++) t.candidates.push({ id: "c" + i, name: "地点" + i, aliases: [], selected: true, materialIds: [], flyai: null, amap: null, choices: [], identity: "pending", identityMeasuredAt: null }); });
  assert.throws(() => routing.makeQuote(other.trip.id, storage.loadTrip(other.trip.id).version), /六个/);
});
check("问答和现有数据重算没有触发网络", () => assert.equal(networkCalls, 0));
await checkAsync("API从凭据识别身份，不能通过正文伪造B", async () => {
  const conditions = emptyConditions("B");
  const request = new Request("http://localhost/api/trips/" + tripId + "/conditions", { method: "PUT", headers: { "x-trip-token": aToken, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: currentVersion(), conditions }) });
  const response = await api.PUT(request, { params: Promise.resolve({ path: [tripId, "conditions"] }) });
  assert.equal(response.status, 200); assert.equal(current().conditions.A.role, "A");
});
await checkAsync("API跨空间凭据读取返回401", async () => {
  const other = store.createTrip("另一个旅行");
  const response = await api.GET(new Request("http://localhost/api/trips/" + other.trip.id, { headers: { "x-trip-token": aToken } }),
    { params: Promise.resolve({ path: [other.trip.id] }) });
  assert.equal(response.status, 401);
});
check("重启读取SQLite恢复资料、成员与版本，不增加费用", () => {
  const code = 'import {loadTrip} from "./src/lib/server/trips/db.ts"; const t=loadTrip(' + JSON.stringify(tripId) + '); console.log(JSON.stringify({version:t.version,b:!!t.members.B,materials:t.materials.length}));';
  const result = JSON.parse(execFileSync(process.execPath, ["--import", "./evidence/register-alias.mjs", "--input-type=module", "-e", code], { cwd: process.cwd(), env: process.env, encoding: "utf8" }).trim());
  assert.equal(result.version, currentVersion()); assert.equal(result.b, true); assert.equal(result.materials, 2);
});
storage.mutate(tripId, (t) => { t.facts.measuredAt = new Date(Date.now() - 7 * 3600000).toISOString(); });
check("事实过期不因读取或资料更新续期", () => {
  assert.equal(store.factsFresh(current()), false); assert.equal(store.execution(current()).allowed, false);
});
check("小时额度持久化，超过上限在请求之前拒绝", () => {
  storage.charge(tripId, "test-budget", 1, 3600000);
  assert.throws(() => storage.charge(tripId, "test-budget", 1, 3600000), /额度/);
});
check("全部离线验收fetch=0", () => assert.equal(networkCalls, 0));
check("不同声明链接的相同内容仍归为一个来源", () => {
  const sample = current().materials.find((m) => !m.deletedAt);
  const a = { ...sample, id: "dup-a", sourceKey: "url-a" }, b = { ...sample, id: "dup-b", sourceKey: "url-b" };
  assert.equal(knowledge.independentSourceCount([a, b], [a.id, b.id]), 1);
});
check("加入响应丢失时同一认领标识可恢复，另一标识不能占用B", () => {
  const t = store.createTrip("加入幂等").trip, invite = store.createInvitation(t.id, "A", 0);
  const claim = "stable_claim_nonce_1234567890";
  const one = store.joinTrip(t.id, invite.invite, claim), version = storage.loadTrip(t.id).version;
  const two = store.joinTrip(t.id, invite.invite, claim);
  assert.equal(one.token, two.token); assert.equal(storage.loadTrip(t.id).version, version);
  assert.throws(() => store.joinTrip(t.id, invite.invite, "different_claim_nonce_123456"), /邀请/);
});
await checkAsync("语义服务失败明确降级，关键词来源仍可读", async () => {
  const result = await knowledge.answerQuestion({ ...qaJob, input: { question: "集贤亭" } }, { ...providers, embed: async () => { throw Error("unavailable"); } });
  assert.equal(result.retrievalMode, "keyword-only"); assert.ok(result.notice); assert.ok(result.citations.length);
});
await checkAsync("没有支持片段的问题明确缺少依据，不调用回答模型", async () => {
  const result = await knowledge.answerQuestion({ ...qaJob, input: { question: "木星酒店库存" } }, { ...providers,
    embed: async () => [Array(512).fill(0)], answer: async () => { throw Error("Must not ask the model without evidence"); } });
  assert.equal(result.citations.length, 0); assert.match(result.answer, /没有找到/);
});
await checkAsync("测量中途失败保留成功路段，重试不重复购买该段", async () => {
  const t = store.createTrip("失败恢复").trip;
  const identityAt = new Date(Date.now() - 5 * 3600000).toISOString();
  const fixture = [{ name: "丙院", position: { lat: 30.28, lng: 120.18 } }, { name: "丁园", position: { lat: 30.29, lng: 120.19 } }];
  storage.mutate(t.id, (trip) => { trip.candidates = fixture.map((p, i) => ({ id: "partial" + i, name: p.name, aliases: [], selected: true, materialIds: [], flyai: null, amap: null, choices: [], identity: "pending", identityMeasuredAt: null })); });
  let calls = 0;
  const p = { async place(name) { const poi = fixture.find((p) => p.name === name); return { ok: true, measuredAt: identityAt, data: poi ? [{ ...poi, id: name, address: "杭州夹具", adname: "上城区", typecode: "110000", opentime: null, rating: null }] : [], error: null, entry: entry("place/text") }; },
    async walk(from, to) { calls++; if (calls === 2) return { ok: false, data: null, error: "网络中断", entry: entry("direction/walking") };
      return { ok: true, data: { distanceMeters: 500, durationSeconds: 400, polyline: [from, to], stepCount: 1, firstInstruction: "夹具" }, error: null, entry: entry("direction/walking") }; } };
  const q = routing.makeQuote(t.id, storage.loadTrip(t.id).version);
  await assert.rejects(() => routing.verifyTrip({ ...verifyJob(q), tripId: t.id }, p), /网络/);
  assert.equal(Object.keys(storage.loadTrip(t.id).facts.legs).length, 1);
  assert.equal(storage.loadTrip(t.id).facts.measuredAt, identityAt);
  assert.equal(store.execution(storage.loadTrip(t.id)).allowed, false);
  const next = routing.makeQuote(t.id, storage.loadTrip(t.id).version);
  await routing.verifyTrip({ ...verifyJob(next), tripId: t.id }, p);
  assert.equal(calls, 5); assert.equal(Object.keys(storage.loadTrip(t.id).facts.legs).length, 4);
});
check("普通数据库读取不误判后台任务为崩溃，恢复动作才标记未知结果", () => {
  const job = storage.enqueue(tripId, "A", "ask", { question: "test" }, "recovery-test-unique");
  storage.updateJob(job.id, "processing");
  const code = 'import {loadTrip} from "./src/lib/server/trips/db.ts"; loadTrip(' + JSON.stringify(tripId) + ');';
  execFileSync(process.execPath, ["--import", "./evidence/register-alias.mjs", "--input-type=module", "-e", code], { cwd: process.cwd(), env: process.env, encoding: "utf8", stdio: "pipe" });
  assert.equal(storage.jobById(job.id).status, "processing");
  storage.recoverInterruptedJobs(); assert.equal(storage.jobById(job.id).status, "failed");
});
check("幂等操作标识不能被另一角色、另一问题或另一任务占用", () => {
  const key = "idempotency-evidence-key";
  const one = store.queueAction(tripId, "A", "ask", { question: "原问题" }, currentVersion(), key);
  assert.equal(store.queueAction(tripId, "A", "ask", { question: "原问题" }, currentVersion(), key).id, one.id);
  assert.throws(() => store.queueAction(tripId, "B", "ask", { question: "原问题" }, currentVersion(), key), /占用/);
  assert.throws(() => store.queueAction(tripId, "A", "ask", { question: "其他问题" }, currentVersion(), key), /复用/);
  assert.throws(() => store.queueAction(tripId, "A", "explain", {}, currentVersion(), key), /占用/);
});
check("必须去与绝不接受冲突在报价前拒绝，不购买数据", () => {
  const t = store.createTrip("底线冲突").trip;
  storage.mutate(t.id, (trip) => {
    trip.candidates = [{ id: "conflict", name: "冲突地点", aliases: [], selected: false, materialIds: [], flyai: null, amap: null, choices: [], identity: "pending", identityMeasuredAt: null }];
    trip.conditions.A.hard.mustVisit = ["conflict"];
    trip.conditions.B = emptyConditions("B"); trip.conditions.B.hard.neverAccept = ["conflict"];
  });
  assert.throws(() => routing.makeQuote(t.id, storage.loadTrip(t.id).version), /发生冲突/);
  assert.equal(networkCalls, 0);
});
check("解释不能用正确数字掩盖偏好妥协、编造内部步行或代替确认", () => {
  const narration = { headline: "当前取舍", details: ["保留已测站点", "移除超限站点", "停留时长为产品设定"], nextSuggestion: "由本人审阅", degraded: false, numericAudit: { unmatched: [] } };
  assert.equal(explanationIssue(narration, false), null);
  for (const line of ["内部步行量为模拟值", "已经满足A方多看几个的条件", "这是全局最短路径", "双方已确认"]) {
    assert.ok(explanationIssue({ ...narration, details: [...narration.details, line] }, false));
  }
});
await checkAsync("生产旅行API拒绝明文HTTP，同时接受HTTPS反代", async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = "production";
  try {
    const context = { params: Promise.resolve({ path: [tripId] }) };
    const denied = await api.GET(new Request("http://travel.example/api/trips/" + tripId, { headers: { "x-trip-token": aToken } }), context);
    assert.equal(denied.status, 426);
    const allowed = await api.GET(new Request("http://travel.example/api/trips/" + tripId, { headers: { "x-trip-token": aToken, "x-forwarded-proto": "https" } }), context);
    assert.equal(allowed.status, 200);
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});
await checkAsync("保留截图原始识别文字，纠错不覆盖原始出处，删除清除内容与原图", async () => {
  const t = store.createTrip("截图纠错").trip, bytes = Buffer.alloc(40);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const mid = store.addMaterial(t.id, "A", t.version, { title: "截图夹具", text: "", sourceUrl: null, image: { buffer: bytes, mime: "image/png" } });
  const provider = { ...providers, extract: async (_id, text) => ({ text: text || "原始识别文字", mentions: [] }) };
  const job = storage.jobsFor(t.id).find((j) => j.input.materialId === mid);
  await knowledge.processMaterial(job, provider); storage.updateJob(job.id, "ready");
  store.changeMaterial(t.id, "A", mid, storage.loadTrip(t.id).version, "人工纠错文字");
  const corrected = storage.jobsFor(t.id).find((j) => j.input.materialVersion === 2);
  await knowledge.processMaterial(corrected, provider);
  let material = storage.loadTrip(t.id).materials[0];
  assert.equal(material.originalText, "原始识别文字"); assert.equal(material.text, "人工纠错文字");
  const file = path.join(directory, "images", t.id, material.image.file);
  store.changeMaterial(t.id, "A", mid, storage.loadTrip(t.id).version, null);
  material = storage.loadTrip(t.id).materials[0];
  assert.equal(material.text, ""); assert.equal(material.originalText, ""); assert.equal(material.chunks.length, 0); assert.equal(fs.existsSync(file), false);
  assert.throws(() => store.materialImage(t.id, mid), /不存在/);
});
await checkAsync("飞猪同名记录不凭名字合并，持久缓存保留原采集时间", async () => {
  const t = store.createTrip("外部证据").trip;
  storage.mutate(t.id, (trip) => { trip.candidates = [{ id: "guide-poi", name: "同名地点", aliases: [], selected: false, materialIds: [], flyai: null, amap: { id: "amap-1" }, choices: [], identity: "verified", identityMeasuredAt: new Date().toISOString() }]; });
  const measuredAt = new Date(Date.now() - 10000).toISOString(); let calls = 0;
  const discover = async () => { calls++; return { ok: true, fetchedAt: measuredAt, results: [{ items: [{ id: "flyai-1", name: "同名地点", source: "live" }], proof: null }] }; };
  const job = { ...verifyJob(quote), tripId: t.id, kind: "enrich", input: { category: "文创街区" } };
  await routing.enrich(job, discover); await routing.enrich(job, discover);
  const trip = storage.loadTrip(t.id);
  assert.equal(calls, 1); assert.equal(trip.candidates.length, 2);
  assert.equal(trip.candidates.find((c) => c.id === "guide-poi").flyai, null);
  assert.equal(trip.candidates.find((c) => c.flyai).flyaiMeasuredAt, measuredAt);
});
await checkAsync("人工纠错移除旧地点关联，新片段原子替换且不再召回旧地点", async () => {
  const t = store.createTrip("索引纠错").trip;
  const mid = await ingest("A", "旧地点：适合漫步。", t.id);
  store.changeMaterial(t.id, "A", mid, storage.loadTrip(t.id).version, "新地点：适合摄影。");
  const job = storage.jobsFor(t.id).find((j) => j.input.materialVersion === 2);
  await knowledge.processMaterial(job, providers);
  const trip = storage.loadTrip(t.id);
  assert.equal(knowledge.independentSourceCount(trip.materials, trip.candidates.find((c) => c.name === "旧地点").materialIds), 0);
  assert.equal(knowledge.independentSourceCount(trip.materials, trip.candidates.find((c) => c.name === "新地点").materialIds), 1);
  assert.ok(trip.materials[0].chunks.every((c) => c.materialVersion === 2 && !c.text.includes("旧地点")));
  assert.ok(retrieval.retrieve(trip.materials[0].chunks, "新地点", null).every((c) => c.text.includes("新地点")));
});
check("更正地点名称后的旧别名仍能通过关键词找到原文", () => {
  const chunk = { id: "alias", text: "旧名小院适合安静坐一会。", vector: null };
  assert.equal(retrieval.retrieve([chunk], "新名称", null, [["新名称", "旧名小院"]])[0].id, "alias");
});
check("新入口沿用旧引擎行政区与坐标比对，不把同名异地当成匹配", () => {
  const flyai = { id: "cross-check", name: "同名公园", address: "西湖区", category: null, position: { lat: 30.25, lng: 120.15 }, jumpUrl: null, description: null };
  const [match] = compareVerifiedPoiPairs([{ flyai, amap: { id: "other-district", name: "同名公园", address: "余杭区", adname: "余杭区", position: { lat: 30.25, lng: 120.15 }, typecode: "110000" } }]);
  assert.equal(match.routable, false); assert.match(match.routableReason, /行政区/);
});
check("没有可行新版本时仍持久保存真实冲突依据，旧确认不能执行", () => {
  const t = store.createTrip("无解证据").trip;
  storage.mutate(t.id, (trip) => { trip.facts = structuredClone(current().facts); trip.facts.measuredAt = new Date().toISOString(); store.solveTrip(trip, "A"); });
  const conditions = emptyConditions("A"); conditions.hard.maxWalkMeters = 1;
  store.saveConditions(t.id, "A", conditions, storage.loadTrip(t.id).version);
  const trip = storage.loadTrip(t.id);
  assert.equal(trip.lastSolve.kind, "hard-conflict"); assert.ok(trip.lastSolve.hardConflict.evidence.length);
  assert.equal(store.execution(trip).allowed, false);
});
await checkAsync("超八公里或交通附属设施在步行测量前被拒绝", async () => {
  for (const [typecode, lat, message] of [["150000", 30.26, /地点本体/], ["110000", 30.45, /八公里/]]) {
    const t = store.createTrip("地点范围").trip;
    storage.mutate(t.id, (trip) => { trip.candidates = [{ id: "scope", name: "范围夹具", aliases: [], selected: true, materialIds: [], flyai: null,
      amap: { id: "scope", name: "范围夹具", position: { lat, lng: 120.15 }, typecode, adname: "上城区", address: "夹具" }, choices: [], identity: "verified", identityMeasuredAt: new Date().toISOString() }]; });
    const q = routing.makeQuote(t.id, storage.loadTrip(t.id).version);
    await assert.rejects(() => routing.verifyTrip({ ...verifyJob(q), tripId: t.id }, { ...routes, walk: async () => { throw Error("Must reject before buying a walking leg"); } }), message);
  }
});
check("较旧的在途核验任务不能被新任务挤出确认门禁", () => {
  const t = store.createTrip("在途任务").trip;
  const job = storage.enqueue(t.id, "A", "verify", {}, "older-verification");
  storage.db().prepare("UPDATE jobs SET created=? WHERE id=?").run(new Date(Date.now() - 10000).toISOString(), job.id);
  for (let i = 0; i < 25; i++) storage.enqueue(t.id, "A", "ask", { question: String(i) }, "later-question-" + i);
  assert.ok(storage.jobsFor(t.id).some((j) => j.id === job.id));
  assert.throws(() => store.confirmTrip(t.id, "A", 1, "hash", storage.loadTrip(t.id).version), /处理中/);
});
console.log(passed + "/" + passed + " workspace checks passed; fetch=" + networkCalls + "; fixtures are NOT live Amap evidence.");
