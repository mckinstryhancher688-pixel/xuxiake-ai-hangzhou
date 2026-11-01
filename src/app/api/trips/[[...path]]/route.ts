import { enabled, TripError, charge, loadTrip, mutate, jobById } from "@/lib/server/trips/db";
import { createTrip, authorizeTrip, snapshot, createInvitation, previewInvitation, revokeInvitation, joinTrip,
  addMaterial, changeMaterial, materialImage, saveConditions, confirmTrip, queueAction, solveTrip } from "@/lib/server/trips/store";
import { editCandidate, makeQuote, mergeCandidates } from "@/lib/server/trips/routing";
import { startWorker, retryJob } from "@/lib/server/trips/worker";
import { TRIP_HEADER } from "@/lib/trips/types";
import { proposeRoute } from "@/lib/negotiation/plan-state";
import { factsFresh } from "@/lib/server/trips/store";

type Context = { params: Promise<{ path?: string[] }> };
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
async function bounded(request: Request, max: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > max) throw new TripError(413, "请求内容过大。");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new TripError(413, "请求内容过大。"); }
    chunks.push(value);
  }
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  const bytes = await bounded(request, 40000);
  if (!bytes.length) return {};
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value;
  } catch { throw new TripError(400, "请求必须是 JSON 对象。"); }
}
function expected(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TripError(400, "必须携带当前空间版本。");
  return Number(value);
}
async function handle(request: Request, context: Context): Promise<Response> {
  if (!enabled()) return json({ error: "旅行空间暂未开放。", code: "feature-disabled" }, 404);
  startWorker();
  try {
    const url = new URL(request.url);
    if (process.env.NODE_ENV === "production" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && url.protocol !== "https:" && request.headers.get("x-forwarded-proto") !== "https") throw new TripError(426, "请通过 HTTPS 打开旅行空间后再操作。");
    const paths = (await context.params).path ?? [], tripId = paths[0], action = paths[1], resource = paths[2];
    if (!tripId && request.method === "POST") {
      charge("creation", "trip-create", 30, 3600000, "global");
      const input = await body(request);
      return json(createTrip(String(input.title ?? "")), 201);
    }
    if (!tripId || !/^trip_[A-Za-z0-9_-]{16}$/.test(tripId)) throw new TripError(404, "旅行空间地址不正确。");
    if (action === "invitation" && resource === "preview" && request.method === "GET")
      return json(previewInvitation(tripId, request.headers.get("x-trip-invite") ?? ""));
    if (action === "join" && request.method === "POST")
      return json(joinTrip(tripId, request.headers.get("x-trip-invite") ?? "", request.headers.get("x-trip-claim") ?? undefined));
    const role = authorizeTrip(tripId, request.headers.get(TRIP_HEADER));
    if (!action && request.method === "GET") return json(snapshot(tripId, role));
    if (action === "materials" && resource && paths[3] === "image" && request.method === "GET") {
      const image = materialImage(tripId, resource);
      return new Response(new Uint8Array(image.buffer), { headers: { "Content-Type": image.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
    }
    if (action === "materials" && !resource && request.method === "POST" && request.headers.get("content-type")?.includes("multipart/form-data")) {
      const bytes = await bounded(request, 6 * 1024 * 1024);
      const multipart = new Request(request.url, { method: "POST", headers: { "Content-Type": request.headers.get("content-type")! }, body: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
      const form = await multipart.formData(), file = form.get("image");
      if (!(file instanceof File)) throw new TripError(400, "请选择一张攻略截图。");
      const rawVersion = form.get("expectedVersion");
      if (typeof rawVersion !== "string" || !/^\d+$/.test(rawVersion)) throw new TripError(400, "必须携带当前空间版本。");
      const version = expected(Number(rawVersion));
      const materialId = addMaterial(tripId, role, version, { title: String(form.get("title") ?? ""),
        text: "", sourceUrl: String(form.get("sourceUrl") ?? "") || null,
        image: { buffer: Buffer.from(await file.arrayBuffer()), mime: file.type } });
      return json({ materialId, snapshot: snapshot(tripId, role) }, 202);
    }
    const input = await body(request);
    const version = expected(input.expectedVersion);
    if (action === "invitation" && request.method === "POST") return json({ ...createInvitation(tripId, role, version), snapshot: snapshot(tripId, role) });
    if (action === "invitation" && request.method === "DELETE") {
      revokeInvitation(tripId, role, version); return json(snapshot(tripId, role));
    }
    if (action === "materials" && !resource && request.method === "POST") {
      const materialId = addMaterial(tripId, role, version, { title: String(input.title ?? ""), text: String(input.text ?? ""),
        sourceUrl: input.sourceUrl ? String(input.sourceUrl) : null });
      return json({ materialId, snapshot: snapshot(tripId, role) }, 202);
    }
    if (action === "materials" && resource && ["PATCH", "DELETE"].includes(request.method)) {
      changeMaterial(tripId, role, resource, version, request.method === "DELETE" ? null : String(input.text ?? ""));
      return json(snapshot(tripId, role));
    }
    if (action === "conditions" && request.method === "PUT") {
      saveConditions(tripId, role, input.conditions, version); return json(snapshot(tripId, role));
    }
    if (action === "candidates" && resource && request.method === "PATCH") {
      editCandidate(tripId, resource, version, input); return json(snapshot(tripId, role));
    }
    if (action === "merge" && request.method === "POST") {
      mergeCandidates(tripId, String(input.keepId), String(input.removeId), version); return json(snapshot(tripId, role));
    }
    if (action === "quote" && request.method === "POST") {
      const quote = makeQuote(tripId, version); return json({ quote, snapshot: snapshot(tripId, role) });
    }
    if (["ask", "enrich", "verify", "explain"].includes(action) && request.method === "POST") {
      if (action === "ask" && (typeof input.question !== "string" || !input.question.trim() || input.question.length > 1000)) throw new TripError(400, "请输入一千字以内的问题。");
      const job = queueAction(tripId, role, action as "ask" | "enrich" | "verify" | "explain", input, version, String(input.requestKey ?? ""));
      return json({ job, snapshot: snapshot(tripId, role) }, 202);
    }
    if (action === "jobs" && resource && request.method === "POST") {
      const job = jobById(resource);
      if (!job || job.tripId !== tripId || job.owner !== role) throw new TripError(403, "只能重试自己的任务。");
      if (loadTrip(tripId).version !== version) throw new TripError(409, "空间已更新，请刷新。");
      retryJob(resource); return json(snapshot(tripId, role));
    }
    if (action === "confirm" && request.method === "POST") {
      if (!Number.isInteger(input.revision) || typeof input.contentHash !== "string") throw new TripError(400, "确认缺少具体版本和内容身份。");
      confirmTrip(tripId, role, Number(input.revision), input.contentHash, version); return json(snapshot(tripId, role));
    }
    if (action === "resolve" && request.method === "POST") {
      mutate(tripId, (trip) => solveTrip(trip, role), version); return json(snapshot(tripId, role));
    }
    if (action === "shorten" && request.method === "POST") {
      const source = loadTrip(tripId);
      if (source.version !== version || !source.plan || !source.facts || !factsFresh(source)) throw new TripError(409, "请先完成当前条件的真实核验。");
      const result = await proposeRoute(source.plan, source.facts, { role, expectedRevision: source.plan.headRevision,
        attemptId: String(input.requestKey ?? ""), now: new Date(),
        measure: async () => { throw new TripError(409, "本操作只复用已测数据；需要补测时请先查看报价，本次未调用高德。"); } });
      mutate(tripId, (trip) => { trip.plan = source.plan; }, version);
      return json({ result, snapshot: snapshot(tripId, role) });
    }
    throw new TripError(405, "不支持这个操作。");
  } catch (error) {
    if (error instanceof TripError) return json({ error: error.message, code: error.code }, error.status);
    console.error("[trips] request failed", error instanceof Error ? error.name : "unknown");
    return json({ error: "服务暂时未完成请求，请刷新查看已保存内容。", code: "internal" }, 500);
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
