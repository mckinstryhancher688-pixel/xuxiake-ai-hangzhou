"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  PLAN_COLLECTION, newAttemptId, parsePlanLink, planActionPath, planReadPath, ROLE_TOKEN_HEADER,
  type MutationView, type PlanSnapshot,
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
    cache: "no-store",
    headers: { "content-type": "application/json", ...(token ? { [ROLE_TOKEN_HEADER]: token } : {}), ...(init?.headers ?? {}) },
  });
  let payload: Record<string, unknown> | null = null;
  try { payload = (await response.json()) as Record<string, unknown>; } catch { payload = null; }
  return { ok: response.ok, status: response.status, payload };
}

function messageOf(payload: Record<string, unknown> | null, status: number): string {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.message === "string") return payload.message;
  return `请求失败（HTTP ${status}）`;
}

function identityKey(identity: PlanIdentity | null): string {
  return identity ? JSON.stringify([identity.planId, identity.role, identity.token]) : "";
}

/** 解释绑定条件与协商事实；轮询时刻、进程号、调试计数变化不代表内容变化。 */
function explanationContext(snapshot: PlanSnapshot | null): string {
  if (!snapshot) return "";
  return JSON.stringify({
    planId: snapshot.planId,
    role: snapshot.role,
    status: snapshot.status,
    headRevision: snapshot.headRevision,
    officialRevision: snapshot.officialRevision,
    conditions: snapshot.conditions,
    head: snapshot.head,
    official: snapshot.official,
    canExecute: snapshot.canExecute,
    facts: snapshot.facts,
    pool: snapshot.pool,
    budget: snapshot.budget,
    revoked: snapshot.revoked,
    expiresAt: snapshot.expiresAt,
  });
}

interface RequestScope {
  key: string;
  closed: boolean;
  mutation: number;
  reading: AbortController | null;
  mutating: boolean;
  explaining: boolean;
  explanationVersion: number;
  explanationContext: string;
}

interface PlanView {
  key: string;
  snapshot: PlanSnapshot | null;
  busy: boolean;
  refreshing: boolean;
  result: MutationView | null;
  error: string | null;
  syncError: string | null;
  updateNotice: string | null;
  explanation: NegotiationExplainResponse | null;
  explaining: boolean;
}

function emptyView(key: string): PlanView {
  return { key, snapshot: null, busy: false, refreshing: false, result: null, error: null, syncError: null,
    updateNotice: null, explanation: null, explaining: false };
}

function closeScope(scope: RequestScope): void {
  scope.closed = true;
  scope.reading?.abort();
  scope.reading = null;
}

/**
 * 版本与执行门禁全部读服务端。自动同步只有 GET，不触发核验、补测或百炼。
 * 退出/换身份后，旧请求不能再写回；每次写入会使在途旧读失效。
 */
export function usePlan(seed: PlanIdentity | null = null, expectedPlanId?: string, restoreStored = true) {
  const stored = useSessionSnapshot<PlanIdentity>(PLAN_IDENTITY_KEY);
  const [override, setOverride] = useState<PlanIdentity | null>(null);
  const [exited, setExited] = useState(false);
  const [dismissedSeed, setDismissedSeed] = useState<PlanIdentity | null>(null);
  const validSeed = seed && seed !== dismissedSeed && (!expectedPlanId || seed.planId === expectedPlanId) ? seed : null;
  const validStored = restoreStored && stored && (!expectedPlanId || stored.planId === expectedPlanId) ? stored : null;
  // 显式链接优先；退出后，同一个 seed 不会把已清掉的身份再写回来。
  const identity = validSeed ?? (exited ? null : (override ?? validStored));
  const key = identityKey(identity);
  const [view, setView] = useState<PlanView>(() => emptyView(""));
  const state = view.key === key ? view : emptyView(key);
  const scopeRef = useRef<RequestScope | null>(null);

  useLayoutEffect(() => {
    const scope: RequestScope = { key, closed: false, mutation: 0, reading: null, mutating: false, explaining: false,
      explanationVersion: 0, explanationContext: "" };
    scopeRef.current = scope;
    return () => closeScope(scope);
  }, [key]);

  const isCurrent = useCallback((scope: RequestScope) => scopeRef.current === scope && !scope.closed, []);
  const update = useCallback((scope: RequestScope, change: (previous: PlanView) => PlanView) => {
    setView((previous) => isCurrent(scope) ? change(previous.key === scope.key ? previous : emptyView(scope.key)) : previous);
  }, [isCurrent]);

  useEffect(() => {
    if (validSeed && identityKey(stored) !== identityKey(validSeed)) saveSnapshot(PLAN_IDENTITY_KEY, validSeed);
  }, [validSeed, stored]);

  const forgetIdentity = useCallback((scope: RequestScope, message: string | null = null) => {
    if (!isCurrent(scope)) return;
    closeScope(scope);
    setExited(true);
    setDismissedSeed(seed);
    setOverride(null);
    clearSnapshot(PLAN_IDENTITY_KEY);
    setView({ ...emptyView(""), error: message });
  }, [isCurrent, seed]);

  const refresh = useCallback(async () => {
    const scope = scopeRef.current;
    if (!identity || !scope || scope.key !== identityKey(identity) || scope.closed || scope.mutating || scope.reading) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort("sync-timeout"), 10_000);
    scope.reading = controller;
    const mutation = scope.mutation;
    update(scope, (previous) => ({ ...previous, refreshing: true }));
    try {
      const { ok, status, payload } = await request(planReadPath(identity.planId), identity.token, { signal: controller.signal });
      if (!isCurrent(scope) || controller.signal.aborted || scope.mutation !== mutation) return;
      if (!ok) {
        if (status === 401 || status === 410) forgetIdentity(scope, messageOf(payload, status));
        else update(scope, (previous) => ({ ...previous, syncError: messageOf(payload, status) }));
        return;
      }
      if (payload?.planId !== identity.planId || payload?.role !== identity.role) {
        update(scope, (previous) => ({ ...previous, syncError: "读取到的协商身份不一致，请重新打开自己的链接。" }));
        return;
      }
      const next = payload as unknown as PlanSnapshot;
      const nextContext = explanationContext(next);
      if (scope.explanationContext && scope.explanationContext !== nextContext) {
        // 不止换版本：失败后的 paused、条件变更和确认记录变化同样使在途解释失效。
        scope.explanationVersion += 1;
        scope.explaining = false;
      }
      scope.explanationContext = nextContext;
      update(scope, (previous) => {
        if ((next.headRevision ?? 0) < (previous.snapshot?.headRevision ?? 0)) return previous;
        const changed = previous.snapshot && previous.snapshot.headRevision !== next.headRevision;
        const contextChanged = explanationContext(previous.snapshot) !== nextContext;
        return { ...previous, snapshot: next, syncError: null,
          explanation: contextChanged ? null : previous.explanation,
          explaining: contextChanged ? false : previous.explaining,
          updateNotice: changed ? `方案已更新到 v${next.headRevision ?? "—"}，请查看变化后确认。` : previous.updateNotice };
      });
    } catch (caught) {
      if (isCurrent(scope) && (!controller.signal.aborted || controller.signal.reason === "sync-timeout") && scope.mutation === mutation) {
        update(scope, (previous) => ({ ...previous, syncError: controller.signal.reason === "sync-timeout"
          ? "协商状态同步超时，请恢复连接后刷新；状态确认前暂停执行。"
          : `同步失败：${caught instanceof Error ? caught.message : String(caught)}` }));
      }
    } finally {
      window.clearTimeout(timeout);
      if (scope.reading === controller) scope.reading = null;
      if (isCurrent(scope) && scope.mutation === mutation) update(scope, (previous) => ({ ...previous, refreshing: false }));
    }
  }, [identity, update, isCurrent, forgetIdentity]);

  useEffect(() => {
    if (!identity) return;
    const syncVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    queueMicrotask(syncVisible);
    const timer = window.setInterval(syncVisible, 3000);
    window.addEventListener("focus", syncVisible);
    document.addEventListener("visibilitychange", syncVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", syncVisible);
      document.removeEventListener("visibilitychange", syncVisible);
    };
  }, [identity, refresh]);

  const beginMutation = useCallback((scope: RequestScope): number | null => {
    if (!isCurrent(scope) || scope.mutating) return null;
    scope.mutating = true;
    scope.mutation += 1;
    scope.explanationVersion += 1;
    scope.explaining = false;
    scope.reading?.abort();
    scope.reading = null;
    update(scope, (previous) => ({ ...previous, busy: true, refreshing: false, error: null, syncError: null,
      updateNotice: null, explanation: null, explaining: false }));
    return scope.mutation;
  }, [isCurrent, update]);

  const send = useCallback(
    async (action: "conditions" | "propose" | "confirm" | "revoke", body: Record<string, unknown>): Promise<MutationView | null> => {
      const scope = scopeRef.current;
      if (!identity || !scope || scope.key !== identityKey(identity)) return null;
      const mutation = beginMutation(scope);
      if (mutation === null) return null;
      try {
        const { ok, status, payload } = await request(planActionPath(identity.planId, action), identity.token, {
          method: "POST", body: JSON.stringify(body),
        });
        if (!isCurrent(scope) || scope.mutation !== mutation) return null;
        const result = (payload?.result as MutationView | undefined) ?? null;
        if (payload?.snapshot) scope.explanationContext = explanationContext(payload.snapshot as PlanSnapshot);
        update(scope, (previous) => ({ ...previous, result,
          snapshot: (payload?.snapshot as PlanSnapshot | undefined) ?? previous.snapshot,
          error: !ok ? (result?.message ?? messageOf(payload, status)) : null }));
        return result;
      } catch (caught) {
        if (isCurrent(scope)) update(scope, (previous) => ({ ...previous,
          error: caught instanceof Error ? caught.message : String(caught),
          syncError: "提交结果尚未确认，正在重新同步；状态确认前暂停执行。" }));
        return null;
      } finally {
        scope.mutating = false;
        if (isCurrent(scope)) update(scope, (previous) => ({ ...previous, busy: false }));
      }
    }, [identity, beginMutation, isCurrent, update],
  );

  const create = useCallback(async (factsId: string) => {
    const scope = scopeRef.current;
    if (!scope) return null;
    const mutation = beginMutation(scope);
    if (mutation === null) return null;
    try {
      const { ok, status, payload } = await request(PLAN_COLLECTION, "", { method: "POST", body: JSON.stringify({ factsId }) });
      if (!isCurrent(scope) || scope.mutation !== mutation) return null;
      if (!ok) {
        update(scope, (previous) => ({ ...previous, error: messageOf(payload, status) }));
        return null;
      }
      const links = payload?.links as { A: string; B: string } | undefined;
      const parsed = links ? parsePlanLink(links.A) : null;
      if (!links || !parsed) {
        update(scope, (previous) => ({ ...previous, error: "服务端没有返回可用的角色链接。" }));
        return null;
      }
      const next: PlanIdentity = { planId: parsed.planId, role: "A", token: parsed.token, links };
      closeScope(scope);
      setExited(false);
      setDismissedSeed(seed);
      setOverride(next);
      saveSnapshot(PLAN_IDENTITY_KEY, next);
      setView({ ...emptyView(identityKey(next)), snapshot: (payload?.snapshot as PlanSnapshot | undefined) ?? null,
        result: (payload?.first as MutationView | undefined) ?? null });
      return next;
    } catch (caught) {
      if (isCurrent(scope)) update(scope, (previous) => ({ ...previous, error: caught instanceof Error ? caught.message : String(caught) }));
      return null;
    } finally {
      scope.mutating = false;
      if (isCurrent(scope)) update(scope, (previous) => ({ ...previous, busy: false }));
    }
  }, [beginMutation, isCurrent, seed, update]);

  const submitConditions = useCallback((conditions: EditorConditions, confirmCost: boolean, expectedCostKey?: string) => send("conditions", {
    conditions, confirmCost, expectedCostKey, expectedRevision: state.snapshot?.headRevision ?? null, attemptId: newAttemptId(),
  }), [send, state.snapshot]);
  const propose = useCallback(() => send("propose", {
    expectedRevision: state.snapshot?.headRevision ?? null, attemptId: newAttemptId(),
  }), [send, state.snapshot]);
  const confirm = useCallback((revision: number, contentHash: string) => send("confirm", { revision, contentHash }), [send]);
  const revoke = useCallback(() => send("revoke", {}), [send]);

  /** 只在明确点击时调用百炼；同步轮询永远不会经过这里。 */
  const explain = useCallback(async (): Promise<NegotiationExplainResponse | null> => {
    const scope = scopeRef.current;
    if (!identity || !scope || scope.key !== identityKey(identity) || scope.closed || scope.mutating || scope.explaining) return null;
    const mutation = scope.mutation;
    const context = explanationContext(state.snapshot);
    if (!context) return null;
    const version = ++scope.explanationVersion;
    scope.explanationContext = context;
    scope.explaining = true;
    const stillCurrent = () => isCurrent(scope) && scope.mutation === mutation
      && scope.explanationVersion === version && scope.explanationContext === context;
    update(scope, (previous) => ({ ...previous, explaining: true, error: null }));
    try {
      const { status, payload } = await request(planActionPath(identity.planId, "explain"), identity.token, {
        method: "POST", body: JSON.stringify({ attemptId: newAttemptId() }),
      });
      if (!stillCurrent()) return null;
      const explanation = (payload?.explanation as NegotiationExplainResponse | undefined) ?? null;
      update(scope, (previous) => explanationContext(previous.snapshot) === context
        ? { ...previous, explanation, error: explanation ? null : messageOf(payload, status) } : previous);
      return explanation;
    } catch (caught) {
      if (stillCurrent()) update(scope, (previous) => ({ ...previous, explanation: null, error: caught instanceof Error ? caught.message : String(caught) }));
      return null;
    } finally {
      if (stillCurrent()) {
        scope.explaining = false;
        update(scope, (previous) => ({ ...previous, explaining: false }));
      }
    }
  }, [identity, isCurrent, state.snapshot, update]);

  const leave = useCallback(() => {
    const scope = scopeRef.current;
    if (scope) forgetIdentity(scope);
  }, [forgetIdentity]);

  return {
    identity, snapshot: state.snapshot, busy: state.busy, result: state.result,
    error: state.error ?? state.syncError, explanation: state.explanation, explaining: state.explaining,
    syncError: state.syncError,
    refreshing: state.refreshing, updateNotice: state.updateNotice, exited: exited && !validSeed,
    reading: identity !== null && state.snapshot === null,
    create, submitConditions, propose, confirm, revoke, leave, explain, refresh,
  };
}

export type PlanController = ReturnType<typeof usePlan>;
export type EditorConditions = {
  hard?: { latestEndMinutes?: number | null; maxWalkMeters?: number | null; mustVisit?: string[]; neverAccept?: string[] };
  soft?: PartyConditions["soft"];
  bias?: PartyConditions["bias"];
};
