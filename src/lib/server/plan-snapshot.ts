import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PlanState } from "@/lib/negotiation/plan-state";
import type { FactSet } from "@/lib/negotiation/types";

if (typeof window !== "undefined") {
  throw new Error("lib/server/plan-snapshot 只能在 Next.js 服务端加载。");
}

/**
 * 单实例最小快照：把协商状态落到一个 JSON 文件，重启后还能接着谈。
 *
 * 刻意不做数据库：演示是一台机器上的两个浏览器，需要的只是「别因为重启就丢掉双方确认」。
 * 因此这里只保证三件事——
 *   1. 原子写（先写 .tmp 再 rename），中途断电不会留下半个文件；
 *   2. 校验和，文件被改坏或写坏时明确判定为损坏并拒绝恢复，不拿半截状态当真的；
 *   3. 只存该存的：事实集（含原采集时间与折线）、条件、版本、确认、撤销、令牌哈希。
 *      API key、角色令牌明文、百炼原始对话一概不落盘。
 *
 * 有效期按原始采集时间算，不按恢复时间算：事实过期就是过期，
 * 必须由端点如实报失效并报价，绝不静默重跑一次付费核验。
 */

const SCHEMA = "xuxiake.plan-snapshot/1";
const MAX_PERSISTED_PLANS = 8;

export interface PersistedPlan {
  planId: string;
  state: PlanState;
  facts: FactSet;
  tokenHashes: { A: string; B: string };
  createdAt: number;
}

interface SnapshotFile {
  schema: string;
  writtenAt: string;
  checksum: string;
  plans: PersistedPlan[];
}

export interface LoadResult {
  plans: PersistedPlan[];
  /** 文件不存在时是 null，其余情况都要如实带出去给界面与日志看 */
  status: "missing" | "loaded" | "corrupt" | "schema-mismatch";
  detail: string | null;
  skipped: { expiredPlan: number; corrupt: number };
}

export interface SaveResult {
  ok: boolean;
  error: string | null;
  file: string;
  bytes: number;
}

export function snapshotFile(): string {
  const configured = process.env.PLAN_SNAPSHOT_FILE?.trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), ".data", "plan-snapshot.json");
}

function canonical(payload: { schema: string; writtenAt: string; plans: PersistedPlan[] }): string {
  return JSON.stringify(payload);
}

function checksumOf(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** 只留最近 N 条，避免文件无上限长大；过期与撤销的也照原样存，恢复后仍然按原判定失效。 */
export function toSnapshotPlans(plans: PersistedPlan[]): PersistedPlan[] {
  return [...plans]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_PERSISTED_PLANS)
    .map((plan) => ({
      planId: plan.planId,
      state: plan.state,
      facts: plan.facts,
      tokenHashes: { A: plan.tokenHashes.A, B: plan.tokenHashes.B },
      createdAt: plan.createdAt,
    }));
}

let writeChain: Promise<SaveResult> = Promise.resolve({ ok: true, error: null, file: "", bytes: 0 });

/** 串行落盘：两次写并发进行会互相踩 .tmp，所以整条链只允许一次在飞。 */
export function persistSnapshot(plans: PersistedPlan[]): Promise<SaveResult> {
  const file = snapshotFile();
  const next = writeChain.then(() => writeSnapshot(file, plans));
  writeChain = next.catch(() => next);
  return next;
}

function writeSnapshot(file: string, plans: PersistedPlan[]): SaveResult {
  const written = toSnapshotPlans(plans);
  const writtenAt = new Date().toISOString();
  const body = canonical({ schema: SCHEMA, writtenAt, plans: written });
  const payload: SnapshotFile = { schema: SCHEMA, writtenAt, checksum: checksumOf(body), plans: written };
  const text = JSON.stringify(payload);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
    return { ok: true, error: null, file, bytes: Buffer.byteLength(text, "utf8") };
  } catch (caught) {
    return {
      ok: false,
      error: caught instanceof Error ? caught.message : String(caught),
      file,
      bytes: 0,
    };
  }
}

export function loadSnapshot(now = Date.now()): LoadResult {
  const file = snapshotFile();
  let raw: string;
  try {
    if (!fs.existsSync(file)) return { plans: [], status: "missing", detail: null, skipped: { expiredPlan: 0, corrupt: 0 } };
    raw = fs.readFileSync(file, "utf8");
  } catch (caught) {
    return {
      plans: [],
      status: "corrupt",
      detail: `快照文件读不出来：${caught instanceof Error ? caught.message : String(caught)}`,
      skipped: { expiredPlan: 0, corrupt: 0 },
    };
  }

  let parsed: SnapshotFile;
  try {
    parsed = JSON.parse(raw) as SnapshotFile;
  } catch (caught) {
    return {
      plans: [],
      status: "corrupt",
      detail: `快照文件不是合法 JSON：${caught instanceof Error ? caught.message : String(caught)}`,
      skipped: { expiredPlan: 0, corrupt: 0 },
    };
  }
  if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.plans) || typeof parsed.checksum !== "string") {
    return { plans: [], status: "schema-mismatch", detail: "快照文件的结构与本版本不一致，已拒绝恢复。", skipped: { expiredPlan: 0, corrupt: 0 } };
  }
  const body = canonical({ schema: parsed.schema, writtenAt: parsed.writtenAt, plans: parsed.plans });
  if (checksumOf(body) !== parsed.checksum) {
    return { plans: [], status: "corrupt", detail: "快照文件的校验和不匹配（内容被改动或写入不完整），已拒绝恢复。", skipped: { expiredPlan: 0, corrupt: 0 } };
  }

  const skipped = { expiredPlan: 0, corrupt: 0 };
  const usable: PersistedPlan[] = [];
  for (const plan of parsed.plans) {
    if (!isWellFormed(plan)) {
      skipped.corrupt += 1;
      continue;
    }
    if (new Date(plan.state.expiresAt).getTime() <= now) {
      skipped.expiredPlan += 1;
      continue;
    }
    usable.push(plan);
  }
  return { plans: usable, status: "loaded", detail: null, skipped };
}

function isWellFormed(plan: PersistedPlan): boolean {
  const state = plan?.state;
  const facts = plan?.facts;
  if (!state || !facts) return false;
  if (typeof plan.planId !== "string" || !plan.planId) return false;
  if (typeof state.headRevision !== "number" && state.headRevision !== null) return false;
  if (!Array.isArray(state.revisions) || !Array.isArray(facts.pool) || !facts.legs || typeof facts.legs !== "object") return false;
  if (typeof facts.measuredAt !== "string" || Number.isNaN(Date.parse(facts.measuredAt))) return false;
  if (typeof state.createdAt !== "string" || typeof state.expiresAt !== "string") return false;
  if (!plan.tokenHashes?.A || !plan.tokenHashes?.B) return false;
  return true;
}

export function snapshotInfo(): { file: string; exists: boolean; bytes: number; writtenAt: string | null; plans: number } {
  const file = snapshotFile();
  // 对外只给相对路径：绝对路径会带上用户名与磁盘结构，没必要出现在状态接口里
  const shown = path.isAbsolute(file) && file.startsWith(process.cwd())
    ? path.relative(process.cwd(), file).replace(/\\/g, "/")
    : path.basename(file);
  try {
    if (!fs.existsSync(file)) return { file: shown, exists: false, bytes: 0, writtenAt: null, plans: 0 };
    const stat = fs.statSync(file);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotFile;
    return {
      file: shown,
      exists: true,
      bytes: stat.size,
      writtenAt: parsed.writtenAt ?? null,
      plans: Array.isArray(parsed.plans) ? parsed.plans.length : 0,
    };
  } catch {
    return { file: shown, exists: false, bytes: 0, writtenAt: null, plans: 0 };
  }
}
