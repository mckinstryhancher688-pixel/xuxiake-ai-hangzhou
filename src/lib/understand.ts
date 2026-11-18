import { MAX_WALK_MINUTES, MIN_WALK_MINUTES, minutesLabel } from "./walk-minutes.ts";

/**
 * 「说说爸妈的情况」那一句话的理解规则。纯函数，不做 IO，便于离线单测。
 *
 * 分工（这是本模块存在的理由）：
 * - 模型只做两件事：判断这句话属于哪一类；需要时写一句追问。
 * - 任何数字都不由模型给出。分钟数由这里的代码，从用户原话里的那一段算出来；
 *   那一段必须逐字出现在用户原文里，否则作废。算不出来就追问，不猜、不换算。
 * - 追问的选项永远是固定菜单（lib/walk-minutes.ts），模型写的问题里如果出现了
 *   用户没说过的时长或距离，整句作废，换成默认问题。
 */

export const UNDERSTAND_MAX_CHARS = 200;
export const DEFAULT_QUESTION = "爸妈全程一共能走多久？";

export interface Understanding {
  /**
   * minutes：从原话里算出了上限（minutes 为 null 表示说的时长比半日行程还长，等于不设上限）；
   * ask：需要追问；off-topic：这句话没讲走路或体力。
   */
  kind: "minutes" | "ask" | "off-topic";
  minutes: number | null;
  /** 用户原话里的那一段（已逐字核对）；kind=minutes 时必有 */
  quote: string | null;
  /** 要展示的问题：模型写的（已过校验）或默认问题 */
  question: string;
  questionFromModel: boolean;
  /** 给用户看的一句说明，全部由代码生成，不是模型写的 */
  note: string | null;
  /** 原话里与「能走多久」无关、这一版还用不上的要求（已逐字核对是原文） */
  other: string[];
  /** model = 模型给出了可用的结论（可能被代码改写过）；fallback = 没读成，给的是默认问题 */
  source: "model" | "fallback";
}

/**
 * 给模型的系统提示。json_object 模式要求提示里出现 "JSON" 字样，否则百炼直接报 400。
 * 规则 3 是关键：「走半小时就得歇」说的是一口气，不是全程，绝不能当成全程上限。
 */
export const UNDERSTAND_SYSTEM_PROMPT = [
  "你在一个「带爸妈出游」的杭州半日路线工具里，只负责读懂子女描述爸妈体力的一句话。",
  "这个工具目前只用一条条件：爸妈全程一共能走多久（这一趟所有步行时间加起来）。",
  "只输出一个 JSON 对象，不要输出任何其它文字。字段如下：",
  '- kind："total"、"ask" 或 "off-topic"。',
  '- quote：kind 为 "total" 时，原样摘录用户话里说全程能走多久的那几个字（必须是原文里连续的一段，并且包含时长）；其它情况为空字符串。',
  '- question：kind 为 "ask" 时，写一句追问，问爸妈全程一共大概能走多久；可以带上用户说的情况（比如膝盖不好），不超过 30 个字，以问号结尾；不要出现任何用户没说过的时长或距离，不要给建议；其它情况为空字符串。',
  "- other：用户话里与能走多久无关的其它要求（比如想去哪、不想去哪、几点回），原样摘录，最多 3 条；没有就是空数组。",
  "判断规则：",
  '1. 用户给出了一个明确的时长，说的是全程最多能走多久（比如「最多走一个小时」「全程走半小时没问题」），kind 为 "total"。',
  '2. 用户只说了身体情况（膝盖不好、容易累、腿脚不便），没有给时长，kind 为 "ask"。',
  '3. 用户说的是一口气、连续走多久就要歇（比如「走半小时就得歇」），那是一次走多久，不是全程，kind 为 "ask"，追问里要讲明问的是全程加起来。',
  '4. 时长含糊（个把小时、一两个小时、一个多小时、不太久、一会儿），kind 为 "ask"。',
  '5. 话里完全没提走路或体力，kind 为 "off-topic"。',
  '6. 一句话里同时有一口气走多久和全程走多久（比如「走半小时就累，但全程加起来一个半小时没问题」），按全程：kind 为 "total"，quote 只摘全程的那一段（比如「全程加起来一个半小时没问题」）。',
  '7. 年龄、楼层、人数等不是步行时长的数字（比如「七十多岁」「八十岁的奶奶」）不算时长；只有这种数字、没有时长时按规则 2 处理。',
  "不要猜测，不要换算，不要自己给出任何数字。",
].join("\n");

/* ── 文本归一：全角转半角、去空白。只用于「是不是原文」的核对，展示仍用原样 ── */

export function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "");
}

function isVerbatim(fragment: string, source: string): boolean {
  const piece = normalizeText(fragment);
  return piece.length > 0 && normalizeText(source).includes(piece);
}

/* ── 中文时长 → 分钟。只认确定的说法，含糊、范围、约数一律返回 null ── */

const NUM_SRC = String.raw`\d+(?:\.\d+)?|[零〇一二两俩三四五六七八九十]+`;

const DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 1~99 的中文数字或阿拉伯数字（可带小数）。「一二」这类不是数的串返回 null。 */
export function parseNumber(token: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(token)) return Number(token);
  if (token.length === 1 && token in DIGIT) return DIGIT[token];
  const tens = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(token);
  if (tens) return (tens[1] ? DIGIT[tens[1]] : 1) * 10 + (tens[2] ? DIGIT[tens[2]] : 0);
  return null;
}

/** 含糊说法：范围（到、至、-）、约数（多、几、来、把）、并列数字（一两、两三） */
const VAGUE = new RegExp(
  [
    "[到至~～\\-—]",
    "或者|还是",
    "个把",
    "几",
    // 「一个多小时」「半个多小时」「二十多分钟」：多 可以在 个 前面也可以在后面
    `[0-9一二两三四五六七八九十半](?:个)?多(?:个)?(?:小时|钟头|分钟)`,
    `[0-9十]来(?:个)?(?:小时|钟头|分钟)`,
    "[一二两三四五六七八九][一二两三四五六七八九](?:个)?(?:小时|钟头|分钟|刻)",
  ].join("|"),
);

const DURATION = new RegExp(
  String.raw`(?<halfHour>半(?:个)?(?:小时|钟头))` +
    String.raw`|(?<h>${NUM_SRC})(?:个)?(?<hHalf>半)?(?:小时|钟头)(?:(?<tailHalf>半)|(?<hm>${NUM_SRC})分(?:钟)?)?` +
    String.raw`|(?<m>${NUM_SRC})分钟` +
    String.raw`|(?<q>[一二两三123])刻钟`,
  "g",
);

/**
 * 从一段话里读出唯一一个确定的时长（分钟）。
 * 「十分」不当分钟（「十分累」）；「半天」不是步行时长；出现两个时长也返回 null——不替用户挑。
 */
export function parseDurationMinutes(raw: string): number | null {
  const text = normalizeText(raw);
  if (!text || VAGUE.test(text)) return null;
  const found: number[] = [];
  for (const match of text.matchAll(DURATION)) {
    const g = match.groups ?? {};
    let minutes: number | null = null;
    if (g.halfHour) {
      minutes = 30;
    } else if (g.h) {
      const hours = parseNumber(g.h);
      if (hours === null) return null;
      minutes = hours * 60 + (g.hHalf || g.tailHalf ? 30 : 0);
      if (g.hm) {
        const extra = parseNumber(g.hm);
        if (extra === null || extra >= 60) return null;
        minutes += extra;
      }
    } else if (g.m) {
      minutes = parseNumber(g.m);
    } else if (g.q) {
      const quarter = parseNumber(g.q);
      minutes = quarter === null ? null : quarter * 15;
    }
    if (minutes === null || !Number.isFinite(minutes)) return null;
    found.push(minutes);
  }
  if (found.length !== 1) return null;
  // 「1.1 小时」这类小数乘 60 会有浮点尾差（66.00000000000001），只吸收尾差，不做真正的取整
  const rounded = Math.round(found[0]);
  if (Math.abs(found[0] - rounded) > 1e-6) return null;
  return rounded > 0 ? rounded : null;
}

/* ── 追问校验：不许出现用户没说过的时长或距离 ── */

const AMOUNT = new RegExp(
  String.raw`半(?:个)?(?:小时|钟头)|(?:${NUM_SRC})(?:个)?半?(?:分钟|小时|钟头|刻钟|公里|千米|米|里|步)`,
  "g",
);

export function safeQuestion(question: unknown, userText: string): string | null {
  if (typeof question !== "string") return null;
  const value = question.trim();
  if (!value || value.length > 40) return null;
  if (!/多久|多长时间/.test(value)) return null;
  // 必须问的是「全程」：真实探针里出现过「一两个小时应该能走多久？」这种没问到点子上的句子
  if (!/全程|一共|加起来|总共/.test(value)) return null;
  if (!/[？?]$/.test(value)) return null;
  for (const match of normalizeText(value).matchAll(AMOUNT)) {
    if (!isVerbatim(match[0], userText)) return null;
  }
  // 兜底：任何一串阿拉伯数字都必须是用户原话里有的
  for (const digits of normalizeText(value).match(/\d+/g) ?? []) {
    if (!normalizeText(userText).includes(digits)) return null;
  }
  return value;
}

/* ── 「一口气」守卫：模型把单次说成全程时，代码再拦一道 ── */

const CONTINUOUS = /一口气|连续|连着|一次|每次|一段|就累|就得歇|就要歇|就歇|得歇|要歇|歇一|歇会|歇歇|休息一下|坐一下|坐会/;
const CLAUSE_BOUNDARY = /[,，。；;！!？?、\n]/;

/**
 * 只看 quote 所在的那一小句：「走半小时就得歇，全程最多一个小时」里，
 * 前半句的「就得歇」不该把后半句的全程上限也拦下来。
 */
function looksContinuous(quote: string, userText: string): boolean {
  const text = normalizeText(userText);
  const piece = normalizeText(quote);
  const at = text.indexOf(piece);
  if (at < 0) return CONTINUOUS.test(piece);
  let start = at;
  while (start > 0 && !CLAUSE_BOUNDARY.test(text[start - 1])) start -= 1;
  let end = at + piece.length;
  while (end < text.length && !CLAUSE_BOUNDARY.test(text[end])) end += 1;
  return CONTINUOUS.test(text.slice(start, end));
}

/**
 * 说的是老人本身（年龄、身体状况）。这类话正是这个工具要听的，不能被当成「没讲走路」，
 * 也不能被列进「这一版还用不上」——真实探针里「带着八十岁的奶奶」就被模型判成了 off-topic。
 */
const ELDER_CUE = /岁|老人|老人家|爷爷|奶奶|外婆|外公|姥姥|姥爷|膝盖|腿|腰|拐杖|轮椅|体力|累|手术|血压|身体/;

function cleanOther(value: unknown, userText: string): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 24 || !isVerbatim(trimmed, userText)) continue;
    if (ELDER_CUE.test(trimmed)) continue;
    if (!out.some((existing) => normalizeText(existing) === normalizeText(trimmed))) out.push(trimmed);
    if (out.length >= 3) break;
  }
  return out;
}

/** 模型没读成（未配置、超限、网络、格式错误）时统一给的结果：退回默认问题，原因如实写出来。 */
export function fallbackUnderstanding(reason: string): Understanding {
  return {
    kind: "ask",
    minutes: null,
    quote: null,
    question: DEFAULT_QUESTION,
    questionFromModel: false,
    note: `这次没读成这句话（${reason}），请直接选一个。`,
    other: [],
    source: "fallback",
  };
}

function ask(question: string | null, note: string | null, other: string[]): Understanding {
  return {
    kind: "ask",
    minutes: null,
    quote: null,
    question: question ?? DEFAULT_QUESTION,
    questionFromModel: question !== null,
    note,
    other,
    source: "model",
  };
}

/**
 * 把模型返回的 JSON 文本变成一个可以安全展示、安全使用的结论。
 * 模型说什么都只是「线索」：quote 要逐字核对，分钟数由代码重算，追问要过数字校验。
 */
export function judgeModelReply(userText: string, content: unknown): Understanding {
  let parsed: Record<string, unknown> | null = null;
  if (typeof content === "string") {
    try {
      const value = JSON.parse(content) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  if (!parsed) return fallbackUnderstanding("模型返回的格式不对");

  const other = cleanOther(parsed.other, userText);
  const kind = parsed.kind;

  if (kind === "off-topic" && ELDER_CUE.test(normalizeText(userText))) {
    // 提到了老人的年龄或身体：按「只说了情况、没给时长」处理，用默认问题追问
    return ask(null, null, other);
  }

  if (kind === "off-topic") {
    return {
      kind: "off-topic",
      minutes: null,
      quote: null,
      question: DEFAULT_QUESTION,
      questionFromModel: false,
      note: "这一版只按「爸妈全程能走多久」来排路线。",
      other,
      source: "model",
    };
  }

  if (kind === "ask") {
    return ask(safeQuestion(parsed.question, userText), null, other);
  }

  if (kind === "total") {
    const quote = typeof parsed.quote === "string" ? parsed.quote.trim() : "";
    if (!quote || !isVerbatim(quote, userText)) {
      return ask(null, "没能从您的话里找到确定的时长，请选一个最接近的。", other);
    }
    if (looksContinuous(quote, userText)) {
      return ask(null, `您说的「${quote}」像是一口气能走多久；这里问的是全程加起来。`, other);
    }
    const minutes = parseDurationMinutes(quote);
    if (minutes === null) {
      return ask(null, `「${quote}」没法换成确定的分钟数，请选一个最接近的。`, other);
    }
    if (minutes < MIN_WALK_MINUTES) {
      return ask(null, `您说的「${quote}」太短，连第一站都走不到，请选一个时间。`, other);
    }
    if (minutes > MAX_WALK_MINUTES) {
      return {
        kind: "minutes",
        minutes: null,
        quote,
        question: DEFAULT_QUESTION,
        questionFromModel: false,
        note: `您说的「${quote}」比半日行程的总时长（4 小时）还长，等于不用限制，这次按不设上限排。`,
        other,
        source: "model",
      };
    }
    return {
      kind: "minutes",
      minutes,
      quote,
      question: DEFAULT_QUESTION,
      questionFromModel: false,
      note: `按您说的「${quote}」，定为 ${minutesLabel(minutes)}。`,
      other,
      source: "model",
    };
  }

  return fallbackUnderstanding("模型返回的类别不认识");
}
