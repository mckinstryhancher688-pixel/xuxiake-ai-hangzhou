"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TRIP_HEADER, type TripSnapshot } from "@/lib/trips/types";

export function useTripWorkspace(tripId: string) {
  const [credential, setCredential] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ title: string; city: string } | null>(null);
  const [snapshot, setSnapshot] = useState<TripSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const live = useRef<TripSnapshot | null>(null);
  const scope = useRef(0);
  const claim = useRef<string | null>(null);
  const base = "/api/trips/" + encodeURIComponent(tripId);
  const install = useCallback((next: TripSnapshot) => {
    if (next.trip.id !== tripId) return;
    if (live.current && next.trip.version < live.current.trip.version) return;
    live.current = next; setSnapshot(next);
  }, [tripId]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const nextInvite = params.get("invite"), nextToken = params.get("token");
    window.history.replaceState(null, "", window.location.pathname);
    let stored: string | null = null;
    let pendingInvite: string | null = nextInvite;
    try {
      if (nextToken) { sessionStorage.setItem("trip:" + tripId, nextToken); sessionStorage.removeItem("trip-invite:" + tripId); }
      else if (nextInvite) sessionStorage.setItem("trip-invite:" + tripId, nextInvite);
      else pendingInvite = sessionStorage.getItem("trip-invite:" + tripId);
      stored = nextToken || sessionStorage.getItem("trip:" + tripId);
    } catch { stored = nextToken; }
    queueMicrotask(() => { setInvite(pendingInvite); setCredential(pendingInvite ? null : stored); setReady(true); });
  }, [tripId]);
  useEffect(() => {
    if (!invite) return;
    const controller = new AbortController();
    fetch(base + "/invitation/preview", { headers: { "x-trip-invite": invite }, cache: "no-store", signal: controller.signal })
      .then(async (r) => { const data = await r.json(); if (!r.ok) throw new Error(data.error); setPreview(data); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [base, invite]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!credential) return;
    const identity = scope.current;
    const response = await fetch(base, { headers: { [TRIP_HEADER]: credential }, cache: "no-store", signal });
    const data = await response.json();
    if (signal?.aborted || identity !== scope.current) return;
    if (!response.ok) throw new Error(data.error ?? "读取旅行失败。");
    install(data);
  }, [base, credential, install]);
  useEffect(() => {
    scope.current++;
    if (!credential) return;
    const controller = new AbortController();
    const poll = () => { void refresh(controller.signal).catch((e) => { if (!controller.signal.aborted) setError(e.message); }); };
    poll(); const timer = setInterval(poll, 2500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [credential, refresh]);
  const act = useCallback(async (action: string, input: Record<string, unknown> = {}, method = "POST", form?: FormData) => {
    if (!credential || !live.current) throw new Error("请先打开自己的旅行链接。");
    setBusy(true); setError(null);
    try {
      const version = live.current.trip.version;
      if (form) form.set("expectedVersion", String(version));
      const response = await fetch(base + "/" + action, { method, headers: { [TRIP_HEADER]: credential,
        ...(form ? {} : { "Content-Type": "application/json" }) },
        body: form ?? JSON.stringify({ ...input, expectedVersion: version, requestKey: input.requestKey ?? crypto.randomUUID() }) });
      const data = await response.json();
      if (data.snapshot) install(data.snapshot);
      else if (data.trip) install(data);
      if (!response.ok) { await refresh(); throw new Error(data.error ?? "操作未完成。"); }
      return data;
    } catch (e) { setError(e instanceof Error ? e.message : "操作未完成。"); return null; }
    finally { setBusy(false); }
  }, [base, credential, install, refresh]);
  const join = useCallback(async () => {
    if (!invite) return;
    setBusy(true); setError(null);
    try {
      claim.current ??= crypto.randomUUID();
      try { claim.current = sessionStorage.getItem("trip-claim:" + tripId) ?? claim.current; sessionStorage.setItem("trip-claim:" + tripId, claim.current); } catch { /* Keep in-memory idempotency if storage is unavailable. */ }
      const response = await fetch(base + "/join", { method: "POST", headers: { "x-trip-invite": invite, "x-trip-claim": claim.current } });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      try { sessionStorage.setItem("trip:" + tripId, data.token); sessionStorage.removeItem("trip-invite:" + tripId); } catch { /* private recovery link remains available */ }
      setInvite(null); setCredential(data.token);
    } catch (e) { setError(e instanceof Error ? e.message : "加入失败。"); }
    finally { setBusy(false); }
  }, [base, invite, tripId]);
  return { snapshot, credential, preview, invite, ready, busy, error, act, join, refresh };
}
