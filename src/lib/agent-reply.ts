import { HEADLINE_MAX_CHARS, MAX_DETAILS, MIN_DETAILS } from "@/lib/agent";
import type { AgentNarration, NumericClaimAudit } from "@/lib/types";

/**
 * 智能体偶尔会包一层 ```json 代码块，或在 JSON 前后多说一句。
 * 只接受第一个 { 到最后一个 } 之间的内容，解析不出来就返回 null 走兜底展示。
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const candidates = [text, stripFence(text)];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

function stripFence(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return fence ? fence[1] : text;
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * 解析失败也要给出可读结果：把原文当开场，明示 degraded，前端会打上「未按格式返回」标记。
 * 绝不因为格式问题而伪造 details。
 */
export function toNarration(data: Record<string, unknown> | null, rawText: string): AgentNarration {
  const fallbackText = rawText.trim();
  if (!data) {
    return {
      headline: truncate(fallbackText, HEADLINE_MAX_CHARS * 2) || "（智能体没有返回文本）",
      details: [],
      nextSuggestion: "",
      degraded: true,
      rawText: fallbackText,
      numericAudit: { claims: [], matched: 0, unmatched: [] },
    };
  }

  const headline =
    typeof data.headline === "string" && data.headline.trim()
      ? data.headline.trim()
      : truncate(fallbackText, HEADLINE_MAX_CHARS * 2);
  const details = stringList(data.details, MAX_DETAILS);
  const nextSuggestion = typeof data.next === "string" ? data.next.trim() : "";

  return {
    headline: truncate(headline, HEADLINE_MAX_CHARS * 2),
    details: details.length >= MIN_DETAILS ? details : [],
    nextSuggestion,
    degraded: details.length < MIN_DETAILS && !nextSuggestion,
    rawText: fallbackText,
    numericAudit: { claims: [], matched: 0, unmatched: [] },
  };
}

function truncate(text: string, limit: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

const CLAIM_PATTERN =
  /(\d[\d,]*(?:\.\d+)?)\s*(米|公里|千米|分钟|min\b|(?![a-zA-Z])m(?![a-zA-Z]))/g;

/**
 * 把回复里出现的每个「数字＋长度/时间单位」都跟服务端实测值比对。
 * 高德算过的距离与耗时是确定的，智能体若凭空报数就会落进 unmatched，
 * 前端把它单独标出来——这是「AI 没有捏造高德结果」的可核查证据，
 * 而不是靠我宣称它没捏造。注意：智能体把几段相加得到的合计也会落进 unmatched，
 * 所以这里是核查线索，不是自动判死刑。
 */
export function auditNumericClaims(
  narration: AgentNarration,
  factMeters: number[],
  factMinutes: number[],
): AgentNarration {
  const text = [narration.headline, ...narration.details, narration.nextSuggestion].join(" ");
  const meters = new Set(factMeters);
  const minutes = new Set(factMinutes);
  const claims: NumericClaimAudit["claims"] = [];

  for (const match of text.matchAll(CLAIM_PATTERN)) {
    const value = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const unit = match[2];
    const isMeters = unit === "米" || unit === "公里" || unit === "千米";
    const scaled = unit === "公里" || unit === "千米" ? Math.round(value * 1000) : Math.round(value);
    claims.push({
      text: match[0],
      value: isMeters ? scaled : Math.round(value),
      unit: isMeters ? "meters" : "minutes",
    });
  }

  const unmatched = claims
    .filter((claim) =>
      claim.unit === "meters" ? !meters.has(claim.value) : !minutes.has(claim.value),
    )
    .map((claim) => claim.text);

  return {
    ...narration,
    numericAudit: { claims, matched: claims.length - unmatched.length, unmatched },
  };
}
