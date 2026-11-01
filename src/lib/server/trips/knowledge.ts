import { LIMITS, type Citation, type Material, type TripAnswer, type TripJob } from "@/lib/trips/types";
import { normalizeText, retrieve, splitChunks } from "@/lib/trips/retrieval";
import { independentSourceCount } from "@/lib/trips/sources";
export { independentSourceCount } from "@/lib/trips/sources";
import { charge, hash, id, loadTrip, mutate, TripError } from "./db";
import { factsFresh, materialImage } from "./store";
import { realProviders, type TripProviders } from "./providers";

export async function processMaterial(job: TripJob, providers: TripProviders = realProviders): Promise<unknown> {
  const before = loadTrip(job.tripId);
  const material = before.materials.find((m) => m.id === job.input.materialId && !m.deletedAt);
  if (!material || material.version !== job.input.materialVersion) return { skipped: true };
  charge(job.tripId, "material-process", LIMITS.processingPerDay, 86400000);
  mutate(job.tripId, (trip) => {
    const item = trip.materials.find((m) => m.id === material.id)!;
    item.status = "processing"; item.indexStatus = "processing"; item.error = null;
  });
  let extracted;
  try {
    extracted = await providers.extract(job.tripId, material.text, material.image && !job.input.corrected ? materialImage(job.tripId, material.id) : null);
  } catch (error) {
    mutate(job.tripId, (trip) => { const item = trip.materials.find((m) => m.id === material.id)!;
      if (item.version === material.version) { item.status = "failed"; item.indexStatus = "failed"; item.error = "识别失败，可手动纠错后重试。"; }
    }); throw error;
  }
  const chunks = splitChunks(extracted.text).map((text, ordinal) => ({ id: material.id + ":" + material.version + ":" + ordinal,
    materialId: material.id, materialVersion: material.version, text, ordinal, vector: null as number[] | null, model: null as string | null }));
  let warning: string | null = null;
  try {
    const vectors = await providers.embed(job.tripId, chunks.map((c) => c.text));
    chunks.forEach((c, i) => { c.vector = vectors[i]; c.model = "text-embedding-v4:512"; });
  } catch { warning = "语义索引暂不可用；资料已保存，可按关键词查找。"; }
  mutate(job.tripId, (trip) => {
    const item = trip.materials.find((m) => m.id === material.id && !m.deletedAt);
    if (!item || item.version !== material.version) return;
    item.text = extracted.text; item.mentions = extracted.mentions; item.chunks = chunks;
    if (item.kind === "image" && !item.originalText && !job.input.corrected) item.originalText = extracted.text;
    if (!item.sourceUrl) item.sourceKey = hash(normalizeText(extracted.text));
    item.status = "ready"; item.indexStatus = warning ? "failed" : "ready"; item.error = warning;
    const previouslyLinked = new Set(trip.candidates.filter((c) => c.materialIds.includes(item.id)).map((c) => c.id));
    for (const candidate of trip.candidates) candidate.materialIds = candidate.materialIds.filter((key) => key !== item.id);
    for (const mention of extracted.mentions) {
      // Group identical labels as unresolved candidates, never claim that names prove geographical identity.
      let candidate = trip.candidates.find((c) => previouslyLinked.has(c.id) && normalizeText(c.name) === normalizeText(mention.name))
        ?? trip.candidates.find((c) => !c.amap && normalizeText(c.name) === normalizeText(mention.name));
      if (!candidate) { candidate = { id: id("stop_"), name: mention.name, aliases: [], selected: false, materialIds: [],
        flyai: null, amap: null, choices: [], identity: "pending", identityMeasuredAt: null }; trip.candidates.push(candidate); }
      if (!candidate.materialIds.includes(item.id)) candidate.materialIds.push(item.id);
    }
    trip.knowledgeVersion++;
  });
  return { materialId: material.id, chunks: chunks.length, warning };
}
export async function answerQuestion(job: TripJob, providers: TripProviders = realProviders): Promise<TripAnswer> {
  const trip = loadTrip(job.tripId), question = String(job.input.question ?? "").trim();
  if (!question || question.length > 1000) throw new TripError(400, "问题需在一千字以内。");
  charge(trip.id, "rag-ask", LIMITS.asksPerDay, 86400000);
  const base = { knowledgeVersion: trip.knowledgeVersion, routeRevision: trip.plan?.headRevision ?? null };
  if (/同意|都确认|谁.*确认/.test(question)) {
    const head = trip.plan?.revisions.find((r) => r.revision === trip.plan?.headRevision);
    const required = head?.requiredConfirmers ?? (trip.members.B ? ["A", "B"] : ["A"]);
    return { ...base, answer: head ? "当前版本 v" + head.revision + "：" + required.map((role) => role + (head.confirmations[role as "A" | "B"]?.contentHash === head.contentHash ? " 已确认" : " 尚未确认")).join("；") + "。是否可执行还需路线事实有效且满足当前条件。" : "尚无可确认的路线版本。上传、浏览和加入均不代表同意。", citations: [], retrievalMode: "keyword-only", notice: "确认状态直接读取服务端记录，不从攻略推断。" };
  }
  if (/(搭子|对方|发起人|[AB]).*(想去|不想|必须|接受|底线|上限|喜欢)|谁.*想去|都.*喜欢/.test(question)) {
    const name = (key: string) => trip.candidates.find((c) => c.id === key)?.name ?? key;
    const describe = ([role, party]: [string, typeof trip.conditions.A | null]) => !party ? role + " 尚未提交条件，不代表接受任何安排。"
      : role + "：步行上限 " + (party.hard.maxWalkMeters === null ? "未设置" : party.hard.maxWalkMeters + " 米") + "；必须去 " + (party.hard.mustVisit.map(name).join("、") || "未设置") + "；绝不接受 " + (party.hard.neverAccept.map(name).join("、") || "未设置") + "；明确偏好 " + (Object.entries(party.soft).map(([key, rank]) => name(key) + "=" + ({ prefer: "特别想去", ok: "可以去", avoid: "不太想去", follow: "愿意跟随" })[rank]).join("、") || "尚未逐站表态") + "。";
    return { ...base, answer: describe(["A", trip.conditions.A]) + "\n" + describe(["B", trip.conditions.B]) + "\n上传攻略不代表上传者本人选择或同意。", citations: [], retrievalMode: "keyword-only", notice: "个人选择直接读取本人提交的条件，不由攻略内容推断。" };
  }
  if (/几份|几次|频次|反复|多次提|都提|统计/.test(question)) {
    const items = trip.candidates.map((c) => ({ c, n: independentSourceCount(trip.materials, c.materialIds) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    return { ...base, answer: items.length ? items.map(({ c, n }) => c.name + "：出现在 " + n + " 份独立资料中。").join("\n") +
      "\n这只统计提及；推荐、不推荐和你们是否想去，请分别查看原文与个人选择。"
      : "当前没有已整理完成的地点资料。", citations: items.slice(0, 6).flatMap(({ c }) => {
        const m = trip.materials.find((m) => c.materialIds.includes(m.id) && !m.deletedAt && m.chunks.length);
        return m ? [citation(m, m.chunks[0].id)] : [];
      }), retrievalMode: "keyword-only", notice: "提及次数由完整结构化记录统计，不由语义检索估计。" };
  }
  if (/几公里|多少米|步行.*(上限|距离|超过)|超过.*公里|能否.*(走|执行)|能不能.*(走|执行)|确认.*版本/.test(question)) {
    const route = trip.plan?.revisions.find((r) => r.revision === trip.plan?.headRevision)?.itinerary;
    return { ...base, answer: route && factsFresh(trip)
      ? "当前已核验版本的路段合计步行 " + route.totalWalkMeters + " 米、" + route.totalWalkMinutes + " 分钟。是否可执行请看行程确认状态；攻略中的耗时不参与计算。"
      : "当前没有仍有效的路线事实，请点击核验路线查看报价。资料问答不会自动调用高德。", citations: [], retrievalMode: "keyword-only", notice: "路线数字来自服务端已核验记录。" };
  }
  const materials = trip.materials.filter((m) => !m.deletedAt && m.status === "ready");
  const chunks = materials.flatMap((m) => m.chunks);
  let vector: number[] | null = null, notice: string | null = null;
  try { if (chunks.some((c) => c.vector)) vector = (await providers.embed(trip.id, [question]))[0]; }
  catch { notice = "语义检索暂不可用，以下按原文关键词查找。"; }
  if (!vector) notice ??= "语义索引尚未就绪，以下按原文关键词查找。";
  const retrieved = retrieve(chunks, question, vector, trip.candidates.map((c) => [c.name, ...c.aliases, ...(c.amap ? [c.amap.name] : [])]));
  if (!retrieved.length) return { ...base, answer: "当前资料中没有找到能支持这个问题的依据。你可以补充资料，或主动查询外部信息。",
    citations: [], retrievalMode: vector ? "hybrid" : "keyword-only", notice };
  const response = await providers.answer(trip, job.owner, question, retrieved);
  const citations = response.citations.flatMap((key) => {
    const material = materials.find((m) => m.chunks.some((c) => c.id === key));
    return material ? [citation(material, key)] : [];
  });
  return { ...base, ...response, citations, retrievalMode: vector ? "hybrid" : "keyword-only", notice: [notice, response.notice].filter(Boolean).join(" ") || null };
}
function citation(material: Material, chunkId: string): Citation {
  const chunk = material.chunks.find((c) => c.id === chunkId)!;
  return { chunkId, materialId: material.id, title: material.title, owner: material.owner, ordinal: chunk.ordinal,
    text: chunk.text, image: !!material.image, sourceUrl: material.sourceUrl };
}
export function knowledgeFingerprint(tripId: string): string {
  const trip = loadTrip(tripId); return hash(JSON.stringify([trip.id, trip.knowledgeVersion, trip.plan?.headRevision]));
}
