"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PLAN_COLLECTION,
  newAttemptId,
  parsePlanLink,
  planActionPath,
  planReadPath,
  ROLE_TOKEN_HEADER,
  type MutationView,
  type PlanSnapshot,
} from "@/lib/plan-api";
import type { PartyConditions, Role } from "@/lib/negotiation/types";
import type { NegotiationExplainResponse } from "@/lib/types";
import { clearSnapshot, PLAN_IDENTITY_KEY, saveSnapshot, useSessionSnapshot } from "@/lib/session-snapshot";

export interface PlanIdentity {
  planId: string;
  role: Role;
  token: string;
  /** 只有发起方那一份标签页里会有两条链接，用于展示与转发 */
  links: { A: string; B: string } | null;
}

async function request(path: string, token: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { [ROLE_TOKEN_HEADER]: token } : {}), ...(init?.headers ?? {}) },
  });
  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  return { ok: response.ok, status: response.status, payload };
}

function messageOf(payload: Record<string, unknown> | null, status: number): string {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.message === "string") return payload.message;
  return `请求失败（HTTP ${status}）`;
}

/**
 * 双人协商的浏览器侧状态。
 * 这里只持有 planId + 本方凭据 + 服务端快照：版本、确认与执行门禁全由服务端判定，
 * 浏览器只负责显示，绝不自己算可行性，也不自己决定「哪一版算正式生效」。
 */
export function usePlan(seed: PlanIdentity | null = null) {
  const stored = useSessionSnapshot<PlanIdentity>(PLAN_IDENTITY_KEY);
  const [override, setOverride] = useState<PlanIdentity | null>(null);
  const identity = override ?? stored ?? seed;

  const [snapshot, setSnapshot] = useState<PlanSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MutationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 最近一次 AI 解释（属于哪个版本由 explanation.revision 自己说明） */
  const [explanation, setExplanation] = useState<NegotiationExplainResponse | null>(null);
  const [explaining, setExplaining] = useState(false);

  // 从同伴链接进来的那一帧：凭据收进本标签页存储（写入外部存储，不是 React 状态）
  useEffect(() => {
    if (!seed) return;
    if (!stored || stored.planId !== seed.planId || stored.token !== seed.token) {
      saveSnapshot(PLAN_IDENTITY_KEY, seed);
    }
  }, [seed, stored]);

  const refresh = useCallback(async () => {
    if (!identity) return;
    const { ok, status, payload } = await request(planReadPath(identity.planId), identity.token);
    if (!ok) {
      setSnapshot(null);
      if (status === 410) {
        clearSnapshot(PLAN_IDENTITY_KEY);
        setOverride(null);
      }
      setError(messageOf(payload, status));
      return;
    }
    setError(null);
    setSnapshot(payload as unknown as PlanSnapshot);
  }, [identity]);

  useEffect(() => {
    if (!identity) return;
    // 用微任务起读：effect 同步阶段不 setState，避免一次进入就级联重渲染
    queueMicrotask(() => void refresh());
  }, [identity, refresh]);

  const send = useCallback(
    async (action: "conditions" | "propose" | "confirm" | "revoke", body: Record<string, unknown>): Promise<MutationView | null> => {
      if (!identity) return null;
      setBusy(true);
      setError(null);
      try {
        const { ok, status, payload } = await request(planActionPath(identity.planId, action), identity.token, {
          method: "POST",
          body: JSON.stringify(body),
        });
        const view = (payload?.result as MutationView | undefined) ?? null;
        if (payload?.snapshot) setSnapshot(payload.snapshot as PlanSnapshot);
        if (!ok && !view) {
          setResult(null);
          setError(messageOf(payload, status));
          return null;
        }
        setResult(view);
        if (view && view.code !== "ok" && status >= 400) setError(view.message);
        return view;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [identity],
  );

  const create = useCallback(
    async (factsId: string) => {
      setBusy(true);
      setError(null);
      try {
        const { ok, status, payload } = await request(PLAN_COLLECTION, "", { method: "POST", body: JSON.stringify({ factsId }) });
        if (!ok) {
          setError(messageOf(payload, status));
          return null;
        }
        const links = payload?.links as { A: string; B: string } | undefined;
        const parsed = links ? parsePlanLink(links.A) : null;
        if (!links || !parsed) {
          setError("服务端没有返回可用的角色链接。");
          return null;
        }
        const next: PlanIdentity = { planId: parsed.planId, role: "A", token: parsed.token, links };
        setOverride(next);
        saveSnapshot(PLAN_IDENTITY_KEY, next);
        setResult((payload?.first as MutationView | undefined) ?? null);
        return next;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const submitConditions = useCallback(
    (conditions: EditorConditions, confirmCost: boolean) =>
      send("conditions", {
        conditions,
        confirmCost,
        expectedRevision: snapshot ? snapshot.headRevision : null,
        attemptId: newAttemptId(),
      }),
    [send, snapshot],
  );

  const propose = useCallback(
    () => send("propose", { expectedRevision: snapshot ? snapshot.headRevision : null, attemptId: newAttemptId() }),
    [send, snapshot],
  );

  const confirm = useCallback(
    (revision: number, contentHash: string) => send("confirm", { revision, contentHash }),
    [send],
  );

  const revoke = useCallback(() => send("revoke", {}), [send]);

  /**
   * 「让 AI 解释这次取舍」：这一步会买一个真实百炼回合，所以只在显式点击时发起。
   * 解释读的是服务端已经算好的事实块；失败时这里拿到的是 ok:false + 服务端原话，
   * 界面上的规则求解结果继续显示，绝不拿固定文案冒充 AI 返回。
   */
  const explain = useCallback(async (): Promise<NegotiationExplainResponse | null> => {
    if (!identity) return null;
    setExplaining(true);
    setError(null);
    try {
      const { ok, payload } = await request(planActionPath(identity.planId, "explain"), identity.token, {
        method: "POST",
        body: JSON.stringify({ attemptId: newAttemptId() }),
      });
      const next = (payload?.explanation as NegotiationExplainResponse | undefined) ?? null;
      setExplanation(next);
      if (!next) setError(typeof payload?.error === "string" ? payload.error : `解释请求失败（HTTP ${String(ok ? "200" : "错误")}）。`);
      return next;
    } catch (caught) {
      setExplanation(null);
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setExplaining(false);
    }
  }, [identity]);

  const leave = useCallback(() => {
    clearSnapshot(PLAN_IDENTITY_KEY);
    setOverride(null);
    setSnapshot(null);
    setResult(null);
    setError(null);
    setExplanation(null);
  }, []);

  return {
    identity,
    snapshot,
    busy,
    result,
    error,
    explanation,
    explaining,
    /** 还没读到过快照且已经在读：界面用它区分「没链接」与「正在读」 */
    reading: identity !== null && snapshot === null && busy === false,
    create,
    submitConditions,
    propose,
    confirm,
    revoke,
    leave,
    explain,
    refresh,
  };
}

export type PlanController = ReturnType<typeof usePlan>;

export type EditorConditions = {
  hard?: { latestEndMinutes?: number | null; maxWalkMeters?: number | null; mustVisit?: string[]; neverAccept?: string[] };
  soft?: PartyConditions["soft"];
  bias?: PartyConditions["bias"];
};
