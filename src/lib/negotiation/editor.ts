import type { PartyConditions, Role, SoftRank } from "./types";

export type PoiChoice = "must" | "never" | SoftRank;

/** 编辑的是完整的本方条件；未显示的结束时间也必须保留。 */
export interface ConditionsDraft {
  choices: Record<string, PoiChoice>;
  cap: string;
  bias: PartyConditions["bias"];
  latestEndMinutes: number | null;
}

export function draftFromConditions(conditions: PartyConditions | null): ConditionsDraft {
  const choices: Record<string, PoiChoice> = { ...conditions?.soft };
  for (const id of conditions?.hard.mustVisit ?? []) choices[id] = "must";
  for (const id of conditions?.hard.neverAccept ?? []) choices[id] = "never";
  return {
    choices,
    cap: conditions?.hard.maxWalkMeters == null ? "" : String(conditions.hard.maxWalkMeters),
    bias: conditions?.bias ?? "neutral",
    latestEndMinutes: conditions?.hard.latestEndMinutes ?? null,
  };
}

/** 对比本方已保存条件，不因同伴的新版本或对象属性顺序误判草稿过期。 */
export function savedConditionsKey(conditions: PartyConditions | null): string {
  const draft = draftFromConditions(conditions);
  return JSON.stringify({ ...draft, choices: Object.entries(draft.choices).sort(([a], [b]) => a.localeCompare(b)) });
}

/** 报价绑定双方条件和方案版本；求解失败也可能改变条件而不增加 revision。 */
export function costApprovalKey(
  planId: string,
  role: Role,
  revision: number | null,
  conditions: { A: PartyConditions; B: PartyConditions | null },
): string {
  return JSON.stringify([planId, role, revision, savedConditionsKey(conditions.A), savedConditionsKey(conditions.B)]);
}

export function conditionsFromDraft(draft: ConditionsDraft): Omit<PartyConditions, "role"> {
  const mustVisit: string[] = [];
  const neverAccept: string[] = [];
  const soft: Record<string, SoftRank> = {};
  for (const [id, choice] of Object.entries(draft.choices)) {
    if (choice === "must") mustVisit.push(id);
    else if (choice === "never") neverAccept.push(id);
    else soft[id] = choice;
  }
  return {
    hard: {
      maxWalkMeters: draft.cap.trim() ? Number(draft.cap.trim()) : null,
      latestEndMinutes: draft.latestEndMinutes,
      mustVisit,
      neverAccept,
    },
    soft,
    bias: draft.bias,
  };
}
