import { db, enabled, jobById, loadTrip, nextJob, updateJob, recoverInterruptedJobs, clearExpired, charge } from "./db";
import { processMaterial, answerQuestion } from "./knowledge";
import { enrich, verifyTrip } from "./routing";
import { realProviders, type TripProviders } from "./providers";

type WorkerState = { running: Promise<void> | null; timer: ReturnType<typeof setInterval> | null; cleanedAt: number };
const globalWorker = globalThis as typeof globalThis & { __xuxiakeTripWorker?: WorkerState };
const state = globalWorker.__xuxiakeTripWorker ??= { running: null, timer: null, cleanedAt: 0 };
export function kickWorker(providers: TripProviders = realProviders): Promise<void> {
  if (state.running) return state.running;
  state.running = (async () => {
    for (;;) {
      const job = nextJob(); if (!job) break;
      updateJob(job.id, "processing");
      try {
        loadTrip(job.tripId);
        if (job.kind === "explain") charge(job.tripId, "rag-ask", 30, 86400000);
        const result = job.kind === "explain" ? await providers.explain(loadTrip(job.tripId), job.owner)
          : job.kind === "material" ? await processMaterial(job, providers)
          : job.kind === "ask" ? await answerQuestion(job, providers)
          : job.kind === "enrich" ? await enrich(job) : await verifyTrip(job);
        updateJob(job.id, "ready", result);
      } catch (error) {
        updateJob(job.id, "failed", null, error instanceof Error ? error.message.slice(0, 600) : "处理未完成，请手动重试。");
      }
    }
  })().finally(() => { state.running = null; });
  return state.running;
}
export function startWorker(): void {
  if (!enabled() || process.env.TRIPS_WORKER_PAUSED === "1" || state.timer) return;
  db();
  recoverInterruptedJobs();
  clearExpired(); state.cleanedAt = Date.now();
  state.timer = setInterval(() => {
    if (Date.now() - state.cleanedAt > 86400000) { try { clearExpired(); state.cleanedAt = Date.now(); } catch { /* Retry cleanup later; existing trips remain readable. */ } }
    void kickWorker().catch(() => {});
  }, 1500);
  state.timer.unref();
  void kickWorker().catch(() => {});
}
export function retryJob(jobId: string): void {
  const job = jobById(jobId);
  if (job?.status === "failed") updateJob(jobId, "pending");
}
