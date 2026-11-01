import type { AgentNarration } from "../types.ts";

/** Additional semantic boundaries that a numeric whitelist alone cannot check. */
export function explanationIssue(narration: AgentNarration, jointlyConfirmed: boolean): string | null {
  if (narration.numericAudit.unmatched.length) return "含未核实的路线数字";
  if (narration.degraded || narration.details.length < 3) return "未提供完整的取舍说明";
  const text = [narration.headline, ...narration.details, narration.nextSuggestion].join("\n");
  if (!jointlyConfirmed && /双方已确认|双方已经确认|双方都同意|双方已同意|双方均已确认|双方一致同意|已经获得双方确认/.test(text)) return "确认说法不符合服务端记录";
  if (/内部步行[^。；\n]{0,25}模拟|模拟[^。；\n]{0,25}内部步行/.test(text)) return "景区内部步行没有数据，不能称为模拟或实测结果";
  if (/满足[^。；\n]{0,30}(多看几个|多逛|强偏好)|偏好(全部|完全|均已)满足|唯一可行|最短路径/.test(text)) return "把软偏好或有限候选比较夸大成完全满足、唯一或全局最短";
  return null;
}
