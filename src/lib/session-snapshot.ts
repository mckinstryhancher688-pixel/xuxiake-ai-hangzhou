"use client";

import { useSyncExternalStore } from "react";

/**
 * 标签页级的行程快照，只为解决「刷新一下，刚核出来的路线和走到第几站全没了」。
 *
 * 用 sessionStorage 而不是 localStorage：随标签页关闭即消失，也不跨设备同步，
 * 另一标签页（比如同伴那一份）读不到本标签页的身份。
 * 里面没有高德/飞猪/百炼的任何密钥。唯一敏感的是 PLAN_IDENTITY_KEY 里的**角色令牌**：
 * 它是访问凭据而不是身份证明，拿到它的人就等于拿到这一方的操作权，
 * 所以只放在标签页级存储、不进地址栏（fragment 首帧读完后立刻清掉）、也不落 localStorage。
 * 注意 sessionStorage 不隔离同页脚本，它不是安全边界，只是防转发/防跨标签的便利手段。
 */
const PREFIX = "xuxiake.session";

export const ROUTE_SNAPSHOT_KEY = `${PREFIX}.route`;
export const AGENT_SNAPSHOT_KEY = `${PREFIX}.agent`;
export const PLAN_IDENTITY_KEY = `${PREFIX}.plan`;

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    // 隐私模式下 sessionStorage 会直接抛，此时当作「没有快照」处理
    return null;
  }
}

export function writeSnapshot(key: string, value: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // 配额满或写入被拒：快照只是体验优化，绝不让主流程因此报错
  }
}

/**
 * 解析结果按原始字符串缓存：useSyncExternalStore 每次渲染都会调 getSnapshot，
 * 每次返回一个新对象会让 React 认为「变了」而无限重渲染。
 */
const parsed = new Map<string, { raw: string | null; value: unknown }>();

function readCached<T>(key: string): T | null {
  const raw = storage()?.getItem(key) ?? null;
  const hit = parsed.get(key);
  if (hit && hit.raw === raw) return hit.value as T | null;
  let value: T | null = null;
  if (raw) {
    try {
      value = JSON.parse(raw) as T;
    } catch {
      value = null;
    }
  }
  parsed.set(key, { raw, value });
  return value;
}

/** 同页写入不会触发 storage 事件，所以本模块自己维护订阅者。 */
const listeners = new Map<string, Set<() => void>>();

function notify(key: string): void {
  listeners.get(key)?.forEach((listener) => listener());
}

function subscribe(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(key, set);
  const onStorage = (event: StorageEvent) => {
    if (event.key === key) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    set.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * 读快照。服务端渲染阶段拿到 null，水合完成后 React 会自动换成本标签页的真实值，
 * 因此不需要「挂载后再 setState」那一步，也不会把首屏 HTML 和客户端渲染对不上。
 */
export function useSessionSnapshot<T>(key: string): T | null {
  return useSyncExternalStore(
    (listener) => subscribe(key, listener),
    () => readCached<T>(key),
    () => null,
  );
}

/** 写快照并唤醒同一页面里的订阅者。 */
export function saveSnapshot(key: string, value: unknown): void {
  writeSnapshot(key, value);
  notify(key);
}

export function clearSnapshot(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* 无存储可用 */
  }
  notify(key);
}
