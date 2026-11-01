import fs from "node:fs";
import path from "node:path";
import { emptyConditions, type PartyConditions, type Role } from "@/lib/negotiation/types";
import { canExecute, commitMeasuredPlan, createPlan, confirmRevision, headRevisionOf } from "@/lib/negotiation/plan-state";
import { LIMITS, type Material, type TripSnapshot, type TripWorkspace } from "@/lib/trips/types";
import { normalizeText } from "@/lib/trips/retrieval";
import { dataDirectory, db, enqueue, hash, id, jobsFor, loadTrip, mutate, requestJob, token, transaction, TripError } from "./db";

export function createTrip(title: string): { trip: TripWorkspace; token: string } {
  const now = new Date(), tripId = id("trip_"), credential = token();
  const trip: TripWorkspace = {
    id: tripId, title: title.trim().slice(0, 80) || "杭州半日同行", city: "杭州",
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 86400000).toISOString(),
    version: 0, knowledgeVersion: 0, members: { A: { role: "A", joinedAt: now.toISOString(), submitted: false }, B: null },
    conditions: { A: emptyConditions("A"), B: null }, materials: [], candidates: [],
    plan: null, facts: null, quote: null, incrementalWalking: 0, initialMeasured: false,
  };
  db().prepare("INSERT INTO trips VALUES(?,?,?,?,?,?)").run(tripId, 0, JSON.stringify(trip), hash(credential), null, Date.parse(trip.expiresAt));
  return { trip, token: credential };
}
export function authorizeTrip(tripId: string, credential: string | null): Role {
  loadTrip(tripId);
  if (!credential || credential.length > 128) throw new TripError(401, "请打开自己的完整旅行链接。");
  const row = db().prepare("SELECT a_hash,b_hash FROM trips WHERE id=?").get(tripId);
  const value = hash(credential);
  if (value === row?.a_hash) return "A";
  if (value === row?.b_hash) return "B";
  throw new TripError(401, "旅行凭据无效，请重新打开自己的链接。");
}
export function factsFresh(trip: TripWorkspace): boolean {
  return !!trip.facts && Date.now() - Date.parse(trip.facts.measuredAt) < 6 * 3600000;
}
export function execution(trip: TripWorkspace): { allowed: boolean; reason: string } {
  if (!trip.plan) return { allowed: false, reason: "还没有已核验的路线。" };
  if (!factsFresh(trip)) return { allowed: false, reason: "路线事实已过期；请查看报价后重新核验，这里不会自动查询。" };
  const head = headRevisionOf(trip.plan);
  if (head?.suspended) return { allowed: false, reason: head.suspended.reason };
  return canExecute(trip.plan, new Date());
}
export function snapshot(tripId: string, role: Role): TripSnapshot {
  const trip = loadTrip(tripId);
  const invitation = db().prepare("SELECT expires,claimed FROM invitations WHERE trip_id=?").get(tripId);
  // Do not expose file paths or source vectors to the browser.
  const safe = structuredClone(trip);
  for (const material of safe.materials) {
    material.chunks = material.chunks.map((chunk) => ({ ...chunk, vector: null }));
    if (material.image) material.image.file = "";
  }
  return { trip: safe, role, jobs: jobsFor(tripId).filter((j) => j.owner === role || j.kind !== "ask").map((j) => ({ ...j, input: j.kind === "material" ? { materialId: j.input.materialId } : {} })),
    invitation: { pending: !!invitation && !invitation.claimed && Number(invitation.expires) > Date.now(),
      expiresAt: invitation ? new Date(Number(invitation.expires)).toISOString() : null }, execution: execution(trip) };
}
export function createInvitation(tripId: string, role: Role, expected: number): { invite: string; expiresAt: string } {
  if (role !== "A") throw new TripError(403, "只有发起人能发送邀请。");
  const invite = token();
  return mutate(tripId, (trip) => {
    if (trip.members.B) throw new TripError(409, "搭子已加入，本期不支持更换成员。");
    const expires = Math.min(Date.now() + 7 * 86400000, Date.parse(trip.expiresAt));
    db().prepare("INSERT OR REPLACE INTO invitations VALUES(?,?,?,0)").run(tripId, hash(invite), expires);
    return { invite, expiresAt: new Date(expires).toISOString() };
  }, expected);
}
export function revokeInvitation(tripId: string, role: Role, expected: number): void {
  if (role !== "A") throw new TripError(403, "只有发起人能撤销待接受邀请。");
  mutate(tripId, (trip) => {
    if (trip.members.B) throw new TripError(409, "搭子已经加入，不能撤销其成员身份。");
    db().prepare("DELETE FROM invitations WHERE trip_id=?").run(tripId);
  }, expected);
}
export function previewInvitation(tripId: string, invite: string): { title: string; city: string } {
  const trip = loadTrip(tripId);
  const row = db().prepare("SELECT * FROM invitations WHERE trip_id=?").get(tripId);
  if (!row || row.hash !== hash(invite) || row.claimed || Number(row.expires) <= Date.now())
    throw new TripError(410, "邀请已被使用、作废或过期，请联系发起人。");
  return { title: trip.title, city: trip.city };
}
export function suspend(trip: TripWorkspace, reason: string): void {
  trip.lastSolve = null;
  if (!trip.plan) return;
  trip.plan.officialRevision = null; trip.plan.status = "paused";
  const head = headRevisionOf(trip.plan);
  if (head) head.suspended = { at: new Date().toISOString(), reason };
}
export function solveTrip(trip: TripWorkspace, role: Role): void {
  if (!trip.facts || !factsFresh(trip)) { suspend(trip, "事实尚未核验或已过期"); return; }
  if (!trip.plan) {
    trip.plan = createPlan(id("plan_"), trip.facts, trip.conditions.A, new Date());
    trip.plan.expiresAt = trip.expiresAt;
  }
  trip.plan.requiredConfirmers = trip.members.B ? ["A", "B"] : ["A"];
  const known = new Set(trip.facts.pool.map((stop) => stop.id));
  const applicable = (party: PartyConditions): PartyConditions => ({ ...structuredClone(party),
    hard: { ...party.hard, neverAccept: party.hard.neverAccept.filter((key) => known.has(key)) },
    soft: Object.fromEntries(Object.entries(party.soft).filter(([key]) => known.has(key))) });
  trip.plan.conditions = { A: applicable(trip.conditions.A), B: trip.conditions.B ? applicable(trip.conditions.B) : null };
  trip.plan.factsId = trip.facts.factsId;
  trip.lastSolve = commitMeasuredPlan(trip.plan, trip.facts, role, new Date()).solve;
}
export function joinTrip(tripId: string, invite: string, claim?: string): { token: string } {
  return transaction(() => {
    if (claim && !/^[A-Za-z0-9_-]{20,100}$/.test(claim)) throw new TripError(400, "加入操作标识无效。");
    const credential = claim ? hash(invite + ":" + claim) : token();
    const prior = db().prepare("SELECT i.hash,i.claimed,t.b_hash FROM invitations i JOIN trips t ON i.trip_id=t.id WHERE t.id=?").get(tripId);
    if (claim && prior?.hash === hash(invite) && prior.claimed && prior.b_hash === hash(credential)) { loadTrip(tripId); return { token: credential }; }
    previewInvitation(tripId, invite);
    mutate(tripId, (trip) => {
      if (trip.members.B) throw new TripError(409, "这个旅行已有两位成员。");
      trip.members.B = { role: "B", joinedAt: new Date().toISOString(), submitted: false };
      trip.conditions.B = null; trip.quote = null;
      db().prepare("UPDATE invitations SET claimed=1 WHERE trip_id=? AND claimed=0").run(tripId);
      db().prepare("UPDATE trips SET b_hash=? WHERE id=?").run(hash(credential), tripId);
      suspend(trip, "搭子已加入，原个人确认不能继续执行");
      if (trip.plan) { trip.plan.requiredConfirmers = ["A", "B"]; trip.plan.conditions.B = null; }
      solveTrip(trip, "B");
    });
    return { token: credential };
  });
}
export function validateConditions(value: unknown, role: Role, trip: TripWorkspace): PartyConditions {
  if (!value || typeof value !== "object") throw new TripError(400, "个人条件格式不正确。");
  const input = value as PartyConditions, hard = input.hard;
  if (!hard || (hard.maxWalkMeters !== null && (!Number.isInteger(hard.maxWalkMeters) || hard.maxWalkMeters < 0 || hard.maxWalkMeters > 100000))
    || (hard.latestEndMinutes !== null && (!Number.isInteger(hard.latestEndMinutes) || hard.latestEndMinutes < 0 || hard.latestEndMinutes >= 1440)))
    throw new TripError(400, "请填写合法的步行上限和结束时间。");
  const validIds = new Set(trip.candidates.map((c) => c.id));
  const list = (items: unknown): string[] => {
    if (!Array.isArray(items) || items.length > 60 || items.some((item) => typeof item !== "string" || !validIds.has(item)))
      throw new TripError(400, "个人选择中包含未知地点。");
    return [...new Set(items as string[])];
  };
  const mustVisit = list(hard.mustVisit), neverAccept = list(hard.neverAccept);
  if (mustVisit.some((key) => neverAccept.includes(key))) throw new TripError(400, "同一地点不能同时必须去和绝不接受。");
  if (!input.soft || Array.isArray(input.soft) || typeof input.soft !== "object") throw new TripError(400, "地点偏好格式不正确。");
  const soft = Object.fromEntries(Object.entries(input.soft).map(([key, rank]) => {
    if (!validIds.has(key) || !["prefer", "ok", "avoid", "follow"].includes(rank)) throw new TripError(400, "地点偏好不可用。");
    return [key, rank];
  })) as PartyConditions["soft"];
  if (!["neutral", "walk_less", "see_more"].includes(input.bias)) throw new TripError(400, "游玩倾向不可用。");
  return { role, hard: { maxWalkMeters: hard.maxWalkMeters, latestEndMinutes: hard.latestEndMinutes, mustVisit, neverAccept }, soft, bias: input.bias };
}
export function saveConditions(tripId: string, role: Role, value: unknown, expected: number): void {
  mutate(tripId, (trip) => {
    const conditions = validateConditions(value, role, trip);
    const fingerprint = (party: PartyConditions | null) => party ? JSON.stringify([party.hard.maxWalkMeters, party.hard.latestEndMinutes, [...party.hard.mustVisit].sort(), [...party.hard.neverAccept].sort(), Object.entries(party.soft).sort(([a], [b]) => a.localeCompare(b)), party.bias]) : "unsubmitted";
    if (trip.members[role]?.submitted && fingerprint(trip.conditions[role]) === fingerprint(conditions)) return;
    trip.conditions[role] = conditions;
    trip.members[role]!.submitted = true; trip.quote = null;
    suspend(trip, role + " 更新了个人条件");
    const known = new Set(trip.facts?.pool.map((s) => s.id) ?? []);
    const requested = [...conditions.hard.mustVisit, ...Object.keys(conditions.soft).filter((key) => conditions.soft[key] === "prefer")];
    if (requested.every((key) => known.has(key))) solveTrip(trip, role);
    else suspend(trip, "新的必须去或特别想去地点尚缺有效事实，请查看报价后主动核验；本次没有调用高德。");
  }, expected);
}
export function confirmTrip(tripId: string, role: Role, revision: number, contentHash: string, expected: number): unknown {
  return mutate(tripId, (trip) => {
    if (jobsFor(tripId).some((job) => job.kind === "verify" && ["pending", "processing"].includes(job.status))) throw new TripError(409, "核验仍在处理中，请等结果更新后再确认。");
    if (!trip.plan || !factsFresh(trip)) throw new TripError(409, "当前没有仍有效的可确认路线。");
    if (!trip.members.A.submitted || (trip.members.B && !trip.members.B.submitted))
      throw new TripError(409, "请双方分别提交个人条件，或明确没有附加条件。");
    const result = confirmRevision(trip.plan, { role, revision, contentHash, now: new Date() });
    if (result.code !== "ok") throw new TripError(409, result.message);
    return result;
  }, expected);
}
export function addMaterial(tripId: string, role: Role, expected: number, input: {
  title: string; text: string; sourceUrl: string | null; image?: { buffer: Buffer; mime: string };
}): string {
  if (input.text.length > LIMITS.textChars) throw new TripError(413, "每份文字最多一万字。");
  if (!input.image && !input.text.trim()) throw new TripError(400, "请粘贴攻略文字。");
  let url: string | null = null;
  if (input.sourceUrl) { try { const parsed = new URL(input.sourceUrl); if (!["https:", "http:"].includes(parsed.protocol)) throw 0; url = parsed.href; }
    catch { throw new TripError(400, "来源链接必须是 HTTP 或 HTTPS 地址。"); } }
  const materialId = id("mat_");
  const contentHash = hash(input.image?.buffer.toString("base64") ?? normalizeText(input.text));
  let savedFile: string | null = null;
  try {
    return mutate(tripId, (trip) => {
      const active = trip.materials.filter((m) => !m.deletedAt);
      if (active.length >= LIMITS.materials) throw new TripError(422, "每个旅行最多保存 20 份资料。");
      if (input.image && active.filter((m) => m.kind === "image").length >= LIMITS.images) throw new TripError(422, "每个旅行最多五张截图。");
      if (input.image && (input.image.buffer.length > LIMITS.imageBytes || !validImage(input.image.buffer, input.image.mime))) throw new TripError(400, "只支持 5 MB 以内的 JPEG、PNG 或 WebP 图片。");
      if (active.some((m) => m.owner === role && m.contentHash === contentHash)) throw new TripError(409, "你已上传过相同资料。");
      const material: Material = { id: materialId, owner: role, title: input.title.trim().slice(0, 100) || "旅行攻略",
        kind: input.image ? "image" : "text", sourceUrl: url, sourceKey: url ? hash(url.replace(/#.*$/, "")) : contentHash,
        contentHash, text: input.text.trim(), originalText: input.text.trim(), image: null, version: 1,
        status: "pending", indexStatus: "pending", error: null, mentions: [], chunks: [], createdAt: new Date().toISOString(), deletedAt: null };
      if (input.image) {
        const directory = path.join(dataDirectory(), "images", tripId);
        fs.mkdirSync(directory, { recursive: true }); savedFile = path.join(directory, materialId);
        fs.writeFileSync(savedFile, input.image.buffer, { flag: "wx" });
        material.image = { file: materialId, mime: input.image.mime, bytes: input.image.buffer.length };
      }
      trip.materials.push(material); trip.knowledgeVersion++;
      enqueue(tripId, role, "material", { materialId, materialVersion: 1 }, "material:" + materialId + ":1");
      return materialId;
    }, expected);
  } catch (error) { if (savedFile) fs.rmSync(savedFile, { force: true }); throw error; }
}
export function validImage(buffer: Buffer, mime: string): boolean {
  if (mime === "image/png") return buffer.length > 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === "image/jpeg") return buffer.length > 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (mime === "image/webp") return buffer.length > 16 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  return false;
}
export function changeMaterial(tripId: string, role: Role, materialId: string, expected: number, text: string | null): void {
  let deletedImage: string | null = null;
  mutate(tripId, (trip) => {
    const material = trip.materials.find((m) => m.id === materialId && !m.deletedAt);
    if (!material) throw new TripError(404, "资料不存在。");
    if (material.owner !== role) throw new TripError(403, "只能修改自己上传的资料。");
    if (text === null) {
      if (material.image) deletedImage = path.join(dataDirectory(), "images", tripId, material.image.file);
      material.deletedAt = new Date().toISOString(); material.chunks = []; material.mentions = [];
      material.text = ""; material.originalText = ""; material.image = null;
    }
    else {
      if (!text.trim() || text.length > LIMITS.textChars) throw new TripError(400, "纠错文字需在一万字以内。");
      material.text = text.trim(); material.version++; material.status = "pending"; material.indexStatus = "pending";
      material.chunks = []; material.error = null;
      enqueue(tripId, role, "material", { materialId, materialVersion: material.version, corrected: true }, "material:" + materialId + ":" + material.version);
    }
    trip.knowledgeVersion++;
    // Source changes never rewrite an adopted itinerary or its confirmations.
  }, expected);
  if (deletedImage) fs.rmSync(deletedImage, { force: true });
}
export function materialImage(tripId: string, materialId: string): { buffer: Buffer; mime: string } {
  const trip = loadTrip(tripId), material = trip.materials.find((m) => m.id === materialId && !m.deletedAt);
  if (!material?.image) throw new TripError(404, "图片不存在。");
  return { buffer: fs.readFileSync(path.join(dataDirectory(), "images", tripId, material.image.file)), mime: material.image.mime };
}
export function queueAction(tripId: string, role: Role, kind: "ask" | "enrich" | "verify" | "explain", input: Record<string, unknown>, expected: number, requestKey: string) {
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(requestKey)) throw new TripError(400, "缺少有效的操作标识。");
  return transaction(() => {
    const prior = requestJob(tripId, requestKey);
    if (prior) {
      if (prior.owner !== role || prior.kind !== kind) throw new TripError(409, "操作标识已被占用。");
      return enqueue(tripId, role, kind, input, requestKey);
    }
    const trip = loadTrip(tripId);
    if (trip.version !== expected) throw new TripError(409, "内容已更新，请刷新后重试。", "stale-version");
    return enqueue(tripId, role, kind, input, requestKey);
  });
}
