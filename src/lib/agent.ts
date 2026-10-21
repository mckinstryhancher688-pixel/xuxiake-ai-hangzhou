import type { ArrivalMode, AgentServerStatus, DataSource } from "@/lib/types";

/** 浏览器只调这一个站内地址；百炼 key 与所有请求都留在服务端。 */
export const AGENT_ENDPOINT = "/api/agent";

export const HEADLINE_MAX_CHARS = 40;
export const MIN_DETAILS = 2;
export const MAX_DETAILS = 3;

/** 同一个会话复用多久；超时就新建会话，代价只是一次免费的 POST /sessions。 */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * 本阶段没有真实定位（第一阶段明令禁止真实地理围栏），
 * 所以「我到了」一律标注为模拟到达，并在 prompt 里写清楚，避免智能体假装知道用户位置。
 */
export const ARRIVAL_MODE: ArrivalMode = "simulated";
export const ARRIVAL_MODE_LABEL =
  ARRIVAL_MODE === "simulated"
    ? "模拟到达：由你点击「我到了」触发，不是手机 GPS 定位"
    : "真实 GPS 定位";

export const AGENT_SOURCE_LABEL = "百炼托管智能体生成（千问），内容不是飞猪或高德的原始数据";

/**
 * 数据源面板里那一行「百炼」的状态：以服务端 GET /api/agent 的真实回执为准，
 * 配置没齐就老实说 MOCK，不做任何「看起来已接通」的美化。
 */
export function agentDataSourceNote(status: AgentServerStatus | null): {
  name: string;
  source: DataSource;
  note: string;
} {
  if (!status) {
    return {
      name: "百炼 Managed Agent",
      source: "mock",
      note: "服务端状态未取到（GET /api/agent 无响应），无法确认是否接通。",
    };
  }
  if (!status.configComplete) {
    return {
      name: "百炼 Managed Agent",
      source: "mock",
      note: `未接通：服务端缺少环境变量 ${status.missingVars.join("、")}，调用会被直接拒绝而不是回落到 Mock。`,
    };
  }
  return {
    name: "百炼 Managed Agent",
    source: "live",
    note: `已接通官方 Managed Agents API：${status.hostMasked}，Agent ${status.agentIdMasked}。「我到了」与「少走一点」每次都是一次真实回合；调用次数与 token 属于调试信息，在下方「开发调试面板」里展开才看得到。`,
  };
}
