import { estimateMissingEdges, metersText } from "./solve";
import { HANGZHOU_TIME_LABEL } from "../hangzhou-time";
import { COST_SCOPE_NOTICE, type FactSet, type PartyConditions, type Role } from "./types";
import type { PlanState, Revision } from "./plan-state";
import { headRevisionOf } from "./plan-state";

/**
 * 把一次双人协商的当前状态压成给智能体的事实块。
 *
 * 这里只搬运服务端已经算出来的东西：条件、判定、有符号差异、实测段、报价。
 * 可行性、数字与硬约束结论都在求解器与状态机里定稿，本模块不做任何判断，
 * 因此可以拿夹具零付费验证——模型拿到什么，界面上就看得见什么。
 */

export interface NextOption {
  key: string;
  text: string;
  /** 这一步会不会新增高德实测；null = 不确定（需要服务端重解才知道） */
  extraCalls: number | null;
}

export interface NegotiationBrief {
  block: string;
  /** 只允许出现在块里的数字，回合结束后按同一口径对账 */
  factMeters: number[];
  factMinutes: number[];
  options: NextOption[];
}

const BIAS_LABEL: Record<PartyConditions["bias"], string> = {
  see_more: "多看几个",
  walk_less: "少走路",
  neutral: "无特定倾向（不代表无异议）",
};

const SOFT_LABEL: Record<string, string> = {
  prefer: "特别想去",
  ok: "可以去",
  avoid: "不太想去",
  follow: "愿意跟随",
};

const STATUS_LABEL: Record<string, string> = {
  "pending-review": "等待双方确认",
  "confirmed-one": "只有一方确认",
  "jointly-confirmed": "双方已确认",
  superseded: "已被新版本取代（确认已挂起）",
  "rolled-back-content": "内容与旧版相同但是新版本，等待双方确认",
};

const OUTCOME_LABEL: Record<string, string> = {
  found: "已找到同时满足双方硬约束的走法",
  "soft-imbalanced": "有可行走法，但一方的强偏好全部落空，需要双方再谈一轮（这不是硬约束冲突）",
  "hard-conflict": "已实测的组合互相矛盾，硬约束无法同时满足",
  "not-measured": "缺实测段，既不能说可行也不能说不可行",
  "constraint-invalid": "条件本身不可用",
};

function nameOf(facts: FactSet, id: string): string {
  if (id === "__start__") return facts.start.name;
  return facts.pool.find((item) => item.id === id)?.name ?? id;
}

function partyLine(facts: FactSet, party: PartyConditions | null): string {
  if (!party) return `${party === null ? "B" : "?"}：尚未提交条件（不代表无异议或已同意）`;
  const hard = [
    party.hard.maxWalkMeters === null ? "未提步行上限" : `步行≤${metersText(party.hard.maxWalkMeters)}`,
    party.hard.mustVisit.length
      ? `必须去 ${party.hard.mustVisit.map((id) => nameOf(facts, id)).join("、")}`
      : "未设置必须去",
    party.hard.neverAccept.length
      ? `绝不接受 ${party.hard.neverAccept.map((id) => nameOf(facts, id)).join("、")}`
      : "未设置绝不接受",
    party.hard.latestEndMinutes === null ? null : `最晚 ${String(Math.floor(party.hard.latestEndMinutes / 60)).padStart(2, "0")}:${String(party.hard.latestEndMinutes % 60).padStart(2, "0")} 结束（${HANGZHOU_TIME_LABEL}）`,
  ]
    .filter(Boolean)
    .join("｜");
  const soft = Object.entries(party.soft)
    .map(([id, rank]) => `${nameOf(facts, id)}=${SOFT_LABEL[rank] ?? rank}`)
    .join("、");
  return `${party.role}：${hard}｜倾向 ${BIAS_LABEL[party.bias]}｜偏好 ${soft || "尚未填写逐站偏好（不代表没有反对意见）"}`;
}

function chainLine(facts: FactSet, stops: { flyaiId: string; name: string }[]): string {
  return [facts.start.name, ...stops.map((stop) => stop.name)].join(" → ");
}

/** 与 auditNumericClaims 同一套换算：块里怎么写，对账时就怎么认。 */
function collectNumbers(block: string): { meters: number[]; minutes: number[] } {
  const meters: number[] = [];
  const minutes: number[] = [];
  for (const match of block.matchAll(/([\d,]+(?:\.\d+)?)\s*(米|公里|千米|分钟)/g)) {
    const value = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    if (match[2] === "分钟") minutes.push(Math.round(value));
    else meters.push(match[2] === "米" ? Math.round(value) : Math.round(value * 1000));
  }
  return { meters, minutes };
}

export function buildNegotiationBrief(input: { facts: FactSet; state: PlanState; revision?: Revision | null }): NegotiationBrief {
  const { facts, state } = input;
  const revision = input.revision ?? headRevisionOf(state) ?? undefined;
  const lines: string[] = [];

  lines.push(
    `【协商】${facts.cityName}｜候选类别 ${facts.categories.join("+") || "未记录"}｜` +
      `事实采集于 ${facts.measuredAt}（高德实测数据，本回合不重新调用外部服务）`,
  );
  lines.push(`【双方条件】${partyLine(facts, state.conditions.A)}`);
  lines.push(`【双方条件】${partyLine(facts, state.conditions.B)}`);
  lines.push("【表达边界】未设置条件、未评价地点只表示没有相应记录，不能写成没有反对意见、愿意接受或已同意；是否同意当前行程只能依据该版本的确认记录。");

  if (!revision) {
    lines.push(`【当前版本】还没有任何版本，方案状态 ${state.status}`);
  } else {
    const solve = revision.solve;
    lines.push(
      `【当前版本】v${revision.revision}（${revision.kind === "proposal" ? "不改变条件的提案" : "条件更新后的新方案"}）` +
        `·${STATUS_LABEL[revision.status] ?? revision.status}｜正式生效版本：` +
        (state.officialRevision === null ? "还没有（双方确认同一版本之前不得执行）" : `v${state.officialRevision}`),
    );
    lines.push(`【服务端判定】${OUTCOME_LABEL[solve.kind] ?? solve.kind}。${solve.note}`);
    if (solve.hardConflict) {
      lines.push(
        `【硬约束矛盾·证据】由 ${solve.hardConflict.byRole} 的「${solve.hardConflict.constraint}」引起：` +
          solve.hardConflict.evidence.join("；"),
      );
    }
    const hits = solve.satisfied.map((hit) => `✓[${hit.role}]${hit.text}`);
    const misses = solve.unmet.map((hit) => `△[${hit.role}]${hit.text}`);
    if (hits.length) lines.push(`【已满足】${hits.join("；")}`);
    if (misses.length) lines.push(`【未满足】${misses.join("；")}`);
    if (solve.unverified.length) lines.push(`【未核实】${solve.unverified.join("；")}`);
    if (revision.diff?.lines.length) lines.push(`【真实差异】${revision.diff.lines.join("；")}`);

    const legs = revision.itinerary.legs
      .map((leg) => `${leg.fromName}→${leg.toName} ${leg.distanceMeters}米/${leg.durationMinutes}分钟`)
      .join("；");
    lines.push(
      `【这一版怎么走】${chainLine(facts, revision.itinerary.stops)}｜` +
        `合计 步行 ${revision.itinerary.totalWalkMeters}米/${revision.itinerary.totalWalkMinutes}分钟｜` +
        `总时长 ${revision.itinerary.totalMinutes} 分钟（预算 ${revision.itinerary.budgetMinutes} 分钟）`,
    );
    if (legs) lines.push(`【高德步行实测，只能照抄这些数字】${legs}`);

    if (solve.runnersUp.length) {
      const alternatives = solve.runnersUp.map(
        (item, index) =>
          `选项${index + 1}：${chainLine(facts, item.stops)} 合计 步行 ${item.totalWalkMeters}米/${item.totalWalkMinutes}分钟｜总时长 ${item.totalMinutes} 分钟`,
      );
      lines.push(`【服务端算出来的其它可行走法】${alternatives.join("；")}`);
    }

    const dropped = solve.dispositions.filter((item) => item.status !== "selected").slice(0, 8);
    if (dropped.length) {
      lines.push(`【没进这一版的站】${dropped.map((item) => `${item.name}=${item.text}`).join("；")}`);
    }
    if (solve.missingEdges.length) {
      lines.push(
        `【还缺的实测段】${solve.missingEdges.length} 条（${solve.missingEdges.map((edge) => edge.name).join("、")}）｜` +
          `补测硬上限 单轮 ${state.budget.perResolveHardMax} 次、本方案 ${state.budget.perPlanHardMax} 次（本方案已用 ${state.budget.spentThisPlan} 次）、本小时余量 ${state.budget.hourlyHeadroomWalking} 次`,
      );
    }
  }
  lines.push(`【口径】${COST_SCOPE_NOTICE}`);

  const block = lines.join("\n");
  const numbers = collectNumbers(block);

  return {
    block,
    factMeters: numbers.meters,
    factMinutes: numbers.minutes,
    options: buildOptions(facts, state, revision),
  };
}

/**
 * 下一步只能是服务端已经能核验的动作：确认、换成另一条已实测走法、
 * 由当事人自己改条件（改之前先报价缺几条实测）。模型只能在这些里面挑。
 */
function buildOptions(facts: FactSet, state: PlanState, revision: Revision | null | undefined): NextOption[] {
  const options: NextOption[] = [];
  if (!revision) return options;

  options.push({
    key: "confirm-current",
    text: `维持 v${revision.revision}，由 A、B 各自点「确认 v${revision.revision}」`,
    extraCalls: 0,
  });
  revision.solve.runnersUp.forEach((item, index) => {
    options.push({
      key: `alternative-${index + 1}`,
      text: `换成另一条已实测走法：${chainLine(facts, item.stops)}（步行 ${item.totalWalkMeters}米）`,
      extraCalls: 0,
    });
  });

  const universe = [state.conditions.A, state.conditions.B]
    .filter(Boolean)
    .flatMap((party) => (party as PartyConditions).hard.neverAccept);
  const candidates = revision.solve.dispositions
    .filter((item) => item.status === "dropped-soft" || item.status === "not-measured")
    .slice(0, 3);
  for (const item of candidates) {
    const quote = estimateMissingEdges(facts, [item.id], {
      universe: facts.pool.filter((stop) => !universe.includes(stop.id)).map((stop) => stop.id),
    });
    options.push({
      key: `must-visit-${item.id}`,
      text: `由 A 或 B 自己提交「必须去 ${item.name}」，服务端在已实测段内重解`,
      extraCalls: quote.length,
    });
  }
  for (const role of ["A", "B"] as Role[]) {
    const party = state.conditions[role];
    if (!party || party.hard.maxWalkMeters === null) continue;
    options.push({
      key: `relax-cap-${role}`,
      text: `由 ${role} 自己调整步行上限（现在 ${metersText(party.hard.maxWalkMeters)}）——别人不能代改，AI 也不能代为同意`,
      extraCalls: null,
    });
  }
  return options;
}
