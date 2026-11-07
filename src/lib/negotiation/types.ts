import type {
  LatLng,
  MatchStatus,
  OpeningStatus,
  RouteStart,
  VerifiedItinerary,
  WalkingLeg,
} from "@/lib/types";

/** 协商层的全部类型都是纯数据：不含高德、飞猪、百炼的任何运行时依赖。 */

export type Role = "A" | "B";

export const FACT_START_KEY = "__start__";

/** 一条有向实测段。反向是另一条段，绝不共用——高德实测不是对称的。 */
export interface FactEntry {
  leg: WalkingLeg;
  /** 实测时间；缓存 TTL 与「这条段还值不值得信」都看它，不看进程内缓存 */
  measuredAt: string;
}

/** 可点选的候选：身份已核验且有高德坐标，包含「最近 6 个」之外的候选。 */
export interface FactStop {
  id: string;
  name: string;
  position: LatLng;
  matchStatus: MatchStatus;
  openingStatus: OpeningStatus;
  openingNote: string;
  /** 模拟值，与单人流程同一口径 */
  stayMinutes: number;
  /** 只做报价排序与「尚未补测」的说明，不参与可行性结论 */
  straightLineMeters: number;
  amapId?: string;
  address?: string | null;
  jumpUrl?: string | null;
  flyaiDescription?: string | null;
  /** 飞猪给的类别与高德给的评分：都是这一轮已经付过费拿到的字段，缺失就是 null */
  category?: string | null;
  rating?: string | null;
  /** 飞猪返回该候选数据的时间；早期事实集没有这个字段 */
  flyaiCollectedAt?: string | null;
  /** id 是否飞猪原样返回；undefined = 早期记录未留存校验信息 */
  flyaiIdFromSource?: boolean;
}

export interface FactSet {
  factsId: string;
  cityName: string;
  categories: string[];
  start: RouteStart;
  pool: FactStop[];
  /** 键 = `${fromId}->${toId}`，起点用 FACT_START_KEY */
  legs: Record<string, FactEntry>;
  /** 高德明确返回「没有路线」的段：有证据的排除，与「从没测过」是两回事 */
  failedPairs: string[];
  measuredAt: string;
}

export interface HardConstraints {
  /** 各自的最晚结束时刻（Asia/Shanghai 当日分钟数，0~1439）；null 表示没提这个要求 */
  latestEndMinutes: number | null;
  /** 本方接受的总步行上限（米）；统计口径见 COST_SCOPE_NOTICE */
  maxWalkMeters: number | null;
  mustVisit: string[];
  neverAccept: string[];
}

export type SoftRank = "prefer" | "ok" | "avoid" | "follow";

export interface PartyConditions {
  role: Role;
  hard: HardConstraints;
  /** 未列出的站按 "ok" 处理 */
  soft: Record<string, SoftRank>;
  bias: "see_more" | "walk_less" | "neutral";
}

export function emptyConditions(role: Role): PartyConditions {
  return {
    role,
    hard: { latestEndMinutes: null, maxWalkMeters: null, mustVisit: [], neverAccept: [] },
    soft: {},
    bias: "neutral",
  };
}

export type SolveOutcomeKind =
  /** 找到满足双方硬约束的方案 */
  | "found"
  /** 方案可行，但一方的强偏好全部落空——仍要出方案，不能查无结果 */
  | "soft-imbalanced"
  /** 已证实不可行：搜索空间全部实测，硬约束互相矛盾 */
  | "hard-conflict"
  /** 尚未核验：缺实测段，无法断言可行也无法断言不可行 */
  | "not-measured"
  /** 条件本身不可用：站 id 不在已核验全集内、既必须去又绝不接受等 */
  | "constraint-invalid";

export type DispositionStatus =
  | "selected"
  | "dropped-soft"
  | "rejected-hard"
  | "rejected-never"
  | "measured-failed"
  | "not-measured";

export interface StopDisposition {
  id: string;
  name: string;
  status: DispositionStatus;
  /** 中文说明，必须落到具体数字或具体条件，不写「已排除」这类无信息结论 */
  text: string;
}

export interface MissingEdge {
  key: string;
  /** 「湖滨公园 → 断桥残雪」这类人读名称 */
  name: string;
}

export interface ConditionHit {
  role: Role;
  kind: "hard" | "soft";
  text: string;
}

export interface JointSolve {
  kind: SolveOutcomeKind;
  best: VerifiedItinerary | null;
  runnersUp: VerifiedItinerary[];
  hardConflict: { byRole: Role | "both"; constraint: string; evidence: string[] } | null;
  /** 去重后的实际缺边：已实测与命中缓存的都不算，所以不是「每站 9 段」的推算值 */
  missingEdges: MissingEdge[];
  /** 逻辑请求数，不含 HTTP 重试 */
  extraLegsNeeded: number;
  satisfied: ConditionHit[];
  unmet: ConditionHit[];
  dispositions: StopDisposition[];
  unverified: string[];
  note: string;
}

/** 步行上限的统计口径，差异卡与条件录入处都必须原文出现，不许省略。 */
export const COST_SCOPE_NOTICE =
  "步行上限只统计「起点→站1→……→最后站」这段高德实测链条，不含回程；" +
  "景区内部的步行量高德不提供，我们也没有数据。" +
  "每站停留 30 分钟是模拟值、全程余量 20 分钟是产品设定，两者都不是实测。" +
  "飞猪与高德都没有返回门票价格，本项目没有任何来自数据的门票/价格字段，因此不构成预算保证。" +
  "营业时间只按假定出发时间判定冲突，不是完整开放时间的保证。";

export interface SignedNumber {
  from: number;
  to: number;
  /** 有符号：正数就是「变多」，不做任何钳位 */
  delta: number;
  direction: "increase" | "decrease" | "same";
}

export interface LegDelta {
  key: string;
  name: string;
  fromMeters: number | null;
  toMeters: number | null;
  /** 只在一侧存在的段为 null：新增或删除，不能显示成「+0」 */
  deltaMeters: number | null;
}

export interface NegotiationDiff {
  fromRevision: number;
  toRevision: number;
  fromHash: string;
  toHash: string;
  totalWalkMeters: SignedNumber;
  totalWalkMinutes: SignedNumber;
  totalMinutes: SignedNumber;
  stopsKept: string[];
  stopsDropped: string[];
  stopsAdded: string[];
  orderChanged: { name: string; fromIndex: number; toIndex: number }[];
  legDeltas: LegDelta[];
  /** 面向双方的整句说明，含方向词，数字全部来自实测段 */
  lines: string[];
}
