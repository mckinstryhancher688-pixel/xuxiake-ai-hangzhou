/**
 * 角色链接是访问凭据，不是身份证明：高熵随机、服务端只存哈希、可比对、可撤销。
 * 会话票据另走一条轴：百炼会话对浏览器出示的票据一律是 randomUUID()，
 * 不能用 planId / role 这类公开信息派生，否则任何知道 planId 的人都能算出另一角色的票据。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

if (typeof window !== "undefined") {
  throw new Error("lib/server/plan-tickets 只能在 Next.js 服务端加载。");
}

const TOKEN_BYTES = 24;

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function mintPlanId(): string {
  return b64url(randomBytes(TOKEN_BYTES));
}

export function mintRoleToken(): string {
  return b64url(randomBytes(TOKEN_BYTES));
}

export function hashCredential(value: string): string {
  return b64url(createHash("sha256").update(value).digest());
}

export function credentialMatches(value: string, storedHash: string): boolean {
  const presented = createHash("sha256").update(value).digest();
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, "base64url");
  } catch {
    return false;
  }
  if (stored.length !== presented.length) return false;
  return timingSafeEqual(presented, stored);
}

/**
 * 百炼会话与回合的去重键必须同时含 planId 与 role：
 * 单人链路按行程内容去重（agent.ts 的 itineraryKey），双人链路同源行程会并进同一个上下文。
 * 这只是服务端内部的键，不是发给浏览器的凭据——对外的票据一律是 randomUUID()。
 */
export function agentScopeKey(planId: string, role: string, itineraryKey: string): string {
  return `${planId}|${role}|${itineraryKey}`;
}

export function agentTurnKey(planId: string, role: string, intentKind: string, tokenOrNew: string, stopId: string): string {
  return `${intentKind}|${planId}|${role}|${tokenOrNew}|${stopId}`;
}
