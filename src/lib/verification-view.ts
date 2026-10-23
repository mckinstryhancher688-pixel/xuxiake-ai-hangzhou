import { parseCategories, type FlyAiPoiCategory } from "./discovery.ts";
import type { VerifyReport } from "./types.ts";

/** 保留已有 sessionStorage 格式；旧 usedCategories 只供兼容，不作为报告来源。 */
export interface RouteSnapshot {
  cityName: string;
  report: VerifyReport;
  usedCategories: FlyAiPoiCategory[];
}

export function reportForCity(cityName: string, override: VerifyReport | null, snapshot: RouteSnapshot | null): VerifyReport | null {
  if (override?.cityName === cityName) return override;
  return snapshot?.cityName === cityName && snapshot.report.cityName === cityName && snapshot.report.itinerary
    ? snapshot.report : null;
}

export function categoriesForReport(report: VerifyReport | null, requestedCategories: FlyAiPoiCategory[]): FlyAiPoiCategory[] {
  // 新请求尚未返回或失败时，也不能给已有报告贴上新类别。
  return report ? parseCategories(report.categories) : requestedCategories;
}

export interface VerificationScope {
  cityName: string;
  sequence: number;
  closed: boolean;
}
export interface VerificationRequest {
  scope: VerificationScope;
  sequence: number;
}

export function createVerificationScope(cityName: string): VerificationScope {
  return { cityName, sequence: 0, closed: false };
}

export function beginVerification(scope: VerificationScope | null): VerificationRequest | null {
  if (!scope || scope.closed) return null;
  return { scope, sequence: ++scope.sequence };
}

export function canApplyVerification(active: VerificationScope | null, request: VerificationRequest): boolean {
  return active === request.scope && !request.scope.closed && request.sequence === request.scope.sequence;
}
