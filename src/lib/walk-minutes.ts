/**
 * 「爸妈全程一共能走多久」这唯一一条条件的选项菜单。
 *
 * 产品原则：数字只能来自用户自己的选择或回答，不由我们根据路线长度推算、更不替用户猜。
 * 所以这里只是一份固定的菜单，外加一个明确的「不确定」；选「不确定」就是不设上限，
 * 先排出一条路线，把它要走多久摆出来，让用户自己看着再调。
 *
 * 单位是分钟：高德本来就实测了每段的步行分钟数，求解器直接对它求和判定，
 * 不需要先假设一个步速把「分钟」换成「米」。
 */
export interface WalkMinuteOption {
  label: string;
  /** 按钮第二行的小字；只有需要解释后果的选项才有，数字档位一行就够 */
  sub?: string;
  /** null = 「不确定」，即不设上限 */
  minutes: number | null;
}

export const WALK_MINUTE_OPTIONS: readonly WalkMinuteOption[] = [
  { label: "30 分钟", minutes: 30 },
  { label: "1 小时", minutes: 60 },
  { label: "1.5 小时", minutes: 90 },
  { label: "不确定", sub: "先不设限", minutes: null },
];

/** 把分钟数说成人话；整小时与半小时用「小时」，其余保持分钟，避免出现「0.83 小时」。 */
export function minutesLabel(minutes: number): string {
  if (minutes >= 60 && minutes % 30 === 0) {
    const hours = minutes / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
  }
  return `${minutes} 分钟`;
}

/**
 * 步行分钟上限的合法范围，/api/resolve 的参数校验与「读一句话」的换算共用这一处。
 * 半日预算只有 240 分钟，步行分钟上限超过它没有意义；低于 5 分钟则连起点到第一站都走不到。
 */
export const MIN_WALK_MINUTES = 5;
export const MAX_WALK_MINUTES = 240;

/**
 * 每站停留多久：唯一开放的第二档调节（用户决定 D2）。缓冲 20 分钟保持固定，不开放。
 * 停留是模拟值（不是实测），所以只给一份固定菜单，接口也只接受这几个数。
 * 默认值与 lib/verification.ts 的 SIMULATED_STAY_MINUTES（30）一致。
 */
export const STAY_MINUTE_OPTIONS = [15, 30, 45, 60] as const;
export const DEFAULT_STAY_MINUTES = 30;

export function isStayOption(value: unknown): value is (typeof STAY_MINUTE_OPTIONS)[number] {
  return typeof value === "number" && (STAY_MINUTE_OPTIONS as readonly number[]).includes(value);
}

/**
 * 结果账单：合计 = 步行（高德实测）+ 停留（站数 × 每站分钟，模拟）+ 缓冲（固定）。
 * 只搬运服务端已经算好的字段，不在前端重新计算合计，避免两边数字打架。
 */
export interface BillInput {
  totalMinutes: number;
  totalWalkMinutes: number;
  totalStayMinutes: number;
  bufferMinutes: number;
  budgetMinutes: number;
  stops: { stayMinutes: number }[];
}

export interface Bill {
  total: number;
  budget: number;
  walk: number;
  stay: number;
  buffer: number;
  stopCount: number;
  /** 每站停留分钟；各站不一样时为 null（目前不会发生，界面只给统一的一档） */
  stayPerStop: number | null;
}

export function billOf(itinerary: BillInput): Bill {
  const first = itinerary.stops[0]?.stayMinutes ?? null;
  const uniform = first !== null && itinerary.stops.every((stop) => stop.stayMinutes === first);
  return {
    total: itinerary.totalMinutes,
    budget: itinerary.budgetMinutes,
    walk: itinerary.totalWalkMinutes,
    stay: itinerary.totalStayMinutes,
    buffer: itinerary.bufferMinutes,
    stopCount: itinerary.stops.length,
    stayPerStop: uniform ? first : null,
  };
}

/** 停留那一项的写法：「3 站 × 30 分钟 = 90 分钟」，各站不一致时只写合计。 */
export function stayText(bill: Bill): string {
  return bill.stayPerStop === null
    ? `${bill.stay} 分钟`
    : `${bill.stopCount} 站 × ${bill.stayPerStop} 分钟 = ${bill.stay} 分钟`;
}

/** 所有展示处共用的口径提醒：时间是高德按步行速度估的，不是真人走一遍。 */
export const WALK_MINUTES_BASIS = "时间按高德的步行速度估，爸妈走得慢会更久。";
