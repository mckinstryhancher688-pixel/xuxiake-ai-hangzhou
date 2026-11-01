import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TripJob, TripWorkspace } from "@/lib/trips/types";

if (typeof window !== "undefined") throw new Error("Trip storage is server only");
export class TripError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "trip-error") { super(message); this.status = status; this.code = code; }
}
export function enabled(): boolean { return process.env.TRIPS_ENABLED === "1"; }
export function dataDirectory(): string {
  return path.resolve(process.env.TRIP_DATA_DIR || (process.env.PLAN_SNAPSHOT_FILE
    ? path.join(path.dirname(process.env.PLAN_SNAPSHOT_FILE), "trips") : ".data/trips"));
}
let connection: DatabaseSync | null = null;
let connectionFile = "";
const shared = globalThis as typeof globalThis & { __xuxiakeTripDatabase?: { file: string; connection: DatabaseSync } };
export function db(): DatabaseSync {
  const file = path.join(dataDirectory(), "trips.sqlite");
  if (shared.__xuxiakeTripDatabase?.file === file) { connection = shared.__xuxiakeTripDatabase.connection; connectionFile = file; return connection; }
  if (connection && connectionFile === file) return connection;
  connection?.close();
  fs.mkdirSync(dataDirectory(), { recursive: true });
  const sql = new DatabaseSync(file);
  sql.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS trips(id TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL, a_hash TEXT NOT NULL, b_hash TEXT, expires INTEGER NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS invitations(trip_id TEXT PRIMARY KEY REFERENCES trips(id), hash TEXT NOT NULL, expires INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0);" +
    "CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,trip_id TEXT NOT NULL REFERENCES trips(id),owner TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,input TEXT NOT NULL,result TEXT,error TEXT,request_key TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL, UNIQUE(trip_id,request_key));" +
    "CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,trip_id TEXT NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL,detail TEXT NOT NULL);" +
    "CREATE INDEX IF NOT EXISTS usage_window ON usage(kind,at);" +
    "CREATE TABLE IF NOT EXISTS evidence(key TEXT PRIMARY KEY,at INTEGER NOT NULL,payload TEXT NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);"
  );
  connection = sql; connectionFile = file;
  shared.__xuxiakeTripDatabase = { file, connection: sql };
  return sql;
}
export function recoverInterruptedJobs(): void {
  db().prepare("UPDATE jobs SET status='failed', error=?, updated=? WHERE status='processing'")
    .run("服务曾在处理中重启，结果未知；请查看已有数据后手动重试。", new Date().toISOString());
}
export function id(prefix: string): string { return prefix + randomBytes(12).toString("base64url"); }
export function token(): string { return randomBytes(32).toString("base64url"); }
export function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
let transactionDepth = 0;
export function transaction<T>(fn: () => T): T {
  if (transactionDepth) return fn();
  const sql = db(); sql.exec("BEGIN IMMEDIATE"); transactionDepth++;
  try { const result = fn(); sql.exec("COMMIT"); return result; }
  catch (error) { sql.exec("ROLLBACK"); throw error; }
  finally { transactionDepth--; }
}
export function loadTrip(tripId: string): TripWorkspace {
  const row = db().prepare("SELECT payload,expires FROM trips WHERE id=?").get(tripId);
  if (!row || Number(row.expires) <= Date.now()) throw new TripError(410, "旅行空间不存在或已超过 30 天保留期。");
  return JSON.parse(String(row.payload)) as TripWorkspace;
}
export function saveTrip(trip: TripWorkspace, expected: number): TripWorkspace {
  trip.version = expected + 1;
  const result = db().prepare("UPDATE trips SET version=?,payload=? WHERE id=? AND version=?")
    .run(trip.version, JSON.stringify(trip), trip.id, expected);
  if (!result.changes) throw new TripError(409, "内容已更新，请刷新后重试。", "stale-version");
  return trip;
}
export function mutate<T>(tripId: string, fn: (trip: TripWorkspace) => T, expected?: number): T {
  return transaction(() => {
    const trip = loadTrip(tripId), version = trip.version;
    if (expected !== undefined && expected !== version) throw new TripError(409, "内容已更新，请刷新后重试。", "stale-version");
    const result = fn(trip); saveTrip(trip, version); return result;
  });
}
type JobRow = Record<string, unknown>;
function jobOf(row: JobRow): TripJob {
  return { id: String(row.id), tripId: String(row.trip_id), owner: row.owner as TripJob["owner"],
    kind: row.kind as TripJob["kind"], status: row.status as TripJob["status"],
    input: JSON.parse(String(row.input)), result: row.result ? JSON.parse(String(row.result)) : null,
    error: row.error ? String(row.error) : null, requestKey: String(row.request_key),
    createdAt: String(row.created), updatedAt: String(row.updated) };
}
export function jobById(jobId: string): TripJob | null {
  const row = db().prepare("SELECT * FROM jobs WHERE id=?").get(jobId); return row ? jobOf(row) : null;
}
export function jobsFor(tripId: string): TripJob[] {
  return db().prepare("SELECT * FROM jobs WHERE trip_id=? AND (status IN ('pending','processing') OR id IN (SELECT id FROM jobs WHERE trip_id=? ORDER BY created DESC LIMIT 20)) ORDER BY created DESC").all(tripId, tripId).map(jobOf);
}
export function requestJob(tripId: string, key: string): TripJob | null {
  const row = db().prepare("SELECT * FROM jobs WHERE trip_id=? AND request_key=?").get(tripId, key);
  return row ? jobOf(row) : null;
}
export function enqueue(tripId: string, owner: TripJob["owner"], kind: TripJob["kind"],
  input: Record<string, unknown>, requestKey: string): TripJob {
  const old = requestJob(tripId, requestKey);
  if (old) {
    const payload = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value).filter(([key]) => !["expectedVersion", "requestKey"].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
    if (old.owner !== owner || old.kind !== kind || payload(old.input) !== payload(input)) throw new TripError(409, "操作标识已经绑定其他请求，不能复用。", "idempotency-conflict");
    return old;
  }
  const now = new Date().toISOString(), jobId = id("job_");
  db().prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(jobId, tripId, owner, kind,
    "pending", JSON.stringify(input), null, null, requestKey, now, now);
  return jobById(jobId)!;
}
export function nextJob(): TripJob | null {
  const row = db().prepare("SELECT * FROM jobs WHERE status='pending' ORDER BY created LIMIT 1").get();
  return row ? jobOf(row) : null;
}
export function updateJob(jobId: string, status: TripJob["status"], result: unknown = null, error: string | null = null): void {
  db().prepare("UPDATE jobs SET status=?,result=?,error=?,updated=? WHERE id=?")
    .run(status, result === null ? null : JSON.stringify(result), error, new Date().toISOString(), jobId);
}
export function charge(tripId: string, kind: string, cap: number, windowMs: number, scope: "trip" | "global" = "trip", detail = ""): string {
  return transaction(() => {
    const row = scope === "trip"
      ? db().prepare("SELECT count(*) AS n FROM usage WHERE trip_id=? AND kind=? AND at>?").get(tripId, kind, Date.now() - windowMs)
      : db().prepare("SELECT count(*) AS n FROM usage WHERE kind=? AND at>?").get(kind, Date.now() - windowMs);
    if (Number(row?.n) >= cap) throw new TripError(429, "本轮服务调用额度已达上限，请稍后再试。", "quota");
    const usageId = id("use_");
    db().prepare("INSERT INTO usage VALUES(?,?,?,?,?)").run(usageId, tripId, kind, Date.now(), detail);
    return usageId;
  });
}
export function usageResult(usageId: string, value: unknown): void { db().prepare("UPDATE usage SET detail=? WHERE id=?").run(JSON.stringify(value), usageId); }
export function evidence<T>(key: string, ttlMs: number): { value: T; at: string } | null {
  const row = db().prepare("SELECT * FROM evidence WHERE key=?").get(key);
  return row && Date.now() - Number(row.at) < ttlMs
    ? { value: JSON.parse(String(row.payload)) as T, at: new Date(Number(row.at)).toISOString() } : null;
}
export function putEvidence(key: string, value: unknown, at = new Date().toISOString()): void {
  db().prepare("INSERT OR REPLACE INTO evidence VALUES(?,?,?)").run(key, Date.parse(at), JSON.stringify(value));
}
export function clearExpired(): void {
  const expired = db().prepare("SELECT id FROM trips WHERE expires<=?").all(Date.now());
  for (const row of expired) transaction(() => {
    db().prepare("DELETE FROM jobs WHERE trip_id=?").run(String(row.id));
    db().prepare("DELETE FROM invitations WHERE trip_id=?").run(String(row.id));
    db().prepare("DELETE FROM trips WHERE id=?").run(String(row.id));
    const imagesRoot = path.resolve(dataDirectory(), "images");
    const target = path.resolve(imagesRoot, String(row.id));
    if (!target.startsWith(imagesRoot + path.sep)) throw new TripError(500, "资料清理路径无效。");
    fs.rmSync(target, { recursive: true, force: true });
  });
  db().prepare("DELETE FROM evidence WHERE (key LIKE 'vector:%' AND at<?) OR (key NOT LIKE 'vector:%' AND at<?)").run(Date.now() - 30 * 86400000, Date.now() - 6 * 3600000);
  db().prepare("DELETE FROM usage WHERE at<?").run(Date.now() - 30 * 86400000);
}
