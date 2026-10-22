import { createHash, randomUUID } from "node:crypto";
import { pickCity, type FlyAiPoiCategory } from "@/lib/discovery";
import { ARRIVAL_MODE } from "@/lib/agent";
import { auditNumericClaims, parseJsonObject, toNarration } from "@/lib/agent-reply";
import type {
  AdjustResponse,
  AgentCallProof,
  AgentProfile,
  AgentServerStatus,
  ExploreResponse,
  MatchStatus,
  NegotiationExplainResponse,
  OpeningStatus,
  RouteSavings,
  VerifiedItinerary,
  VerifiedStop,
  WalkingLeg,
} from "@/lib/types";
import {
  BUDGET_MINUTES,
  SIMULATED_STAY_MINUTES,
  VERIFY_DISTRICT,
  assumedTripWindow,
} from "@/lib/verification";
import { amapCounters, planWalking } from "./amap";
import {
  bailianCounters,
  createSession,
  fetchAgentProfile,
  maskId,
  maskKey,
  missingBailianVars,
  readBailianConfig,
  runTurn,
  turnCapMessage,
  type BailianConfig,
  type TurnResult,
} from "./bailian";
import { verifyRoute } from "./verify";
import { composeItinerary, toLeg } from "@/lib/itinerary-compose";
import { buildNegotiationBrief } from "@/lib/negotiation/ai-context";
import { headRevisionOf } from "@/lib/negotiation/plan-state";
import type { Role } from "@/lib/negotiation/types";
import { executionBlockReason, planExecutionJourney, planForBrief } from "./plan-store";
import { agentScopeKey, agentTurnKey } from "./plan-tickets";

if (typeof window !== "undefined") {
  throw new Error("lib/server/agent 只能在 Next.js 服务端加载。");
}

/**
 * 浏览器只持有一个随机票据（token），服务端用它换真实的百炼 Session ID。
 * 真实 Session ID 与 key 一样不出服务端：GET /sessions/{id} 会把注入的环境变量
 * 原样返回，任何把裸会话对象外传的写法都等于泄密。
 */
interface AgentSession {
  sessionId: string;
  lastUsedAt: number;
  /** 这条会话聊的是哪几个站；行程变了就重开一条，避免上下文对不上 */
  itineraryKey: string;
  /** 建会话时实际下发的覆盖项，凭证里要能证明内置工具确实被摘掉了 */
  overrides: string[];
  /** 这条会话的上下文里已经出现过哪一份数据块 */
  contextFingerprint: string | null;
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const EXPLORE_TIMEOUT_MS = 90_000;
const SHORTEN_TIMEOUT_MS = 90_000;

/**
 * 常驻规则放进会话级 system（实测 agent_with_overrides 接受 system 与 tools，
 * 但拒绝 agent.model），每一条用户消息就只剩数据和任务本身。
 */
const SESSION_SYSTEM = [
  "你是「徐霞客 AI：杭州半日漫游」的在场讲解智能体。服务端把飞猪 POI 与高德实测数据交给你的文字里，那是唯一可用的事实来源。",
  "只能使用给定数据。数据里没有的价格、门票、开放时间细节、历史年份、人物故事、实时人流、天气，一律不许编造；确实需要提及时只能说「数据未提供，需现场核实」。",
  "不要调用任何工具，不要执行 bash，不要安装任何东西，不要联网搜索，直接基于给定文本回答。",
  "数字（米、分钟）必须照抄给定值，不换算、不相加。",
  "用户是模拟到达而不是真实定位，不要说「我看到你」「你正站在」这类声称知道位置的话，改用「走到这里时」。",
  "只输出一个 JSON 对象，不要 markdown 代码块，不要多余文字。",
].join("\n");

const sessions = new Map<string, AgentSession>();
type OpenedSession = {
  token: string;
  sessionId: string;
  overrides: string[];
  contextFingerprint: string | null;
};
const sessionTasks = new Map<string, Promise<OpenedSession>>();
/** 同一作用域 + 同一意图只允许一个回合在飞：双击不会变成两次付费调用 */
const turnTasks = new Map<string, Promise<ExploreResponse | AdjustResponse | NegotiationExplainResponse>>();

function pruneSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [token, session] of sessions) {
    if (session.lastUsedAt < cutoff) sessions.delete(token);
  }
}

/**
 * 取或建一条百炼会话。
 *
 * 单人链路照旧：浏览器持有一个随机票据，票据就是会话表的键。
 * 双人链路传 ownerKey（planId + 角色 + 版本），会话改由服务端按这个键持有，
 * 浏览器传来的票据一概不认——这样 A 无论拿到什么，都指不到 B 的会话上。
 */
async function getOrCreateSession(
  config: BailianConfig,
  itineraryKey: string,
  clientToken: string | null,
  ownerKey: string | null = null,
): Promise<OpenedSession> {
  pruneSessions();
  const key = ownerKey ?? clientToken;
  if (key) {
    const existing = sessions.get(key);
    if (existing && existing.itineraryKey === itineraryKey) {
      existing.lastUsedAt = Date.now();
      return {
        token: key,
        sessionId: existing.sessionId,
        overrides: existing.overrides,
        contextFingerprint: existing.contextFingerprint,
      };
    }
    if (existing && ownerKey === null) sessions.delete(key);
  }

  const pending = sessionTasks.get(itineraryKey);
  if (pending) return pending;

  const task = (async () => {
    const created = await createSession(config, `徐霞客-杭州半日漫游`, {
      system: SESSION_SYSTEM,
      disableTools: true,
    });
    if (!created.ok || !created.sessionId) {
      throw new Error(created.error ?? "百炼会话创建失败。");
    }
    const token = ownerKey ?? randomUUID();
    sessions.set(token, {
      sessionId: created.sessionId,
      lastUsedAt: Date.now(),
      itineraryKey,
      overrides: created.appliedOverrides,
      contextFingerprint: null,
    });
    return {
      token,
      sessionId: created.sessionId,
      overrides: created.appliedOverrides,
      contextFingerprint: null,
    };
  })();

  sessionTasks.set(itineraryKey, task);
  try {
    return await task;
  } finally {
    sessionTasks.delete(itineraryKey);
  }
}

/** 数据块一旦发出去就留在会话历史里，后续回合不必重发。 */
function markContextSent(token: string, fingerprint: string): void {
  const session = sessions.get(token);
  if (session) session.contextFingerprint = fingerprint;
}

/* ── 行程状态：全部由服务端从已核实报告推导，不接受浏览器传来的坐标 ───── */

export interface JourneyIntent {
  cityName: string;
  /** 已核实行程里当前所在的那一站（飞猪 POI id） */
  stopId: string | null;
  interests: string[];
  /**
   * 这份行程当初是用哪些飞猪类别核出来的。必须回传：否则智能体读到的是默认类别
   * 重新核验的那条路线，跟用户界面上看到的不是同一条。
   */
  categories: FlyAiPoiCategory[];
  /**
   * 双人模式：由端点用角色凭据换出来的作用域。带着它时，智能体读的是这条协商
   * 双方确认的正式版本，不再按 city/categories 去取那条单人路线。
   */
  plan?: { planId: string; role: Role };
}

class AgentRefused extends Error {}

/** 智能体只需要这两项补充事实：类别来自飞猪，评分来自高德，都是这一轮已经付过费的字段。 */
interface MatchRowLite {
  flyaiId: string;
  category: string | null;
  rating: string | null;
}

interface ResolvedJourney {
  itinerary: VerifiedItinerary;
  cityName: string;
  matchRows: MatchRowLite[];
  stops: VerifiedStop[];
  legs: WalkingLeg[];
  /** 到达当前站即视为走过 stops[0..currentIndex] */
  visited: VerifiedStop[];
  remaining: VerifiedStop[];
  current: VerifiedStop;
  historyLegs: WalkingLeg[];
  elapsedMinutes: number;
  remainingMinutes: number;
  itineraryKey: string;
  interests: string[];
}

/** 兴趣只接受应用自己的这套词表，其余字符串一律丢弃，避免任意文本进 prompt。 */
const INTEREST_WHITELIST = [
  "安静街区",
  "自然风光",
  "摄影",
  "历史人文",
  "本地生活",
  "文创",
  "湖景",
  "免费景点",
];

/** 两条链路共用同一套「按当前站切分已走过/还没走」的算法，避免出现两套进度口径。 */
function shapeJourney(input: {
  itinerary: VerifiedItinerary;
  cityName: string;
  matchRows: MatchRowLite[];
  stopId: string | null;
  interests: string[];
  itineraryKey: string;
  notInRouteMessage?: string;
}): ResolvedJourney {
  const { itinerary, stopId } = input;
  const { stops, legs } = itinerary;
  const requested = stops.findIndex((stop) => stop.flyaiId === stopId);
  if (requested === -1 && stopId) {
    throw new AgentRefused(
      input.notInRouteMessage ??
        `选中的站点不在已核实行程里（收到 id「${String(stopId).slice(0, 24)}」），请重新选择。`,
    );
  }
  const currentIndex = requested === -1 ? 0 : requested;
  const visitedCount = currentIndex + 1;
  const visited = stops.slice(0, visitedCount);
  // legs[i] 结尾就是 stops[i]，所以已走过的段正好是前 visitedCount 条
  const historyLegs = legs.slice(0, visitedCount);
  const elapsedMinutes =
    historyLegs.reduce((sum, leg) => sum + leg.durationMinutes, 0) + visitedCount * SIMULATED_STAY_MINUTES;

  return {
    itinerary,
    cityName: input.cityName,
    matchRows: input.matchRows,
    stops,
    legs,
    current: stops[currentIndex],
    visited,
    remaining: stops.slice(visitedCount),
    historyLegs,
    elapsedMinutes: Math.min(elapsedMinutes, BUDGET_MINUTES),
    remainingMinutes: Math.max(0, BUDGET_MINUTES - elapsedMinutes),
    itineraryKey: input.itineraryKey,
    interests: input.interests.filter((item) => INTEREST_WHITELIST.includes(item)),
  };
}

async function resolveJourney(intent: JourneyIntent): Promise<ResolvedJourney> {
  const keyOf = (stops: VerifiedStop[]) => stops.map((stop) => stop.flyaiId).join(",");

  /* 双人：只读这条协商双方确认的正式版本。门禁没开就直接拒绝，绝不拿单人路线顶数。 */
  if (intent.plan) {
    const journey = planExecutionJourney(intent.plan.planId);
    if (!journey) {
      throw new AgentRefused(
        `这条协商现在没有可正式执行的版本：${executionBlockReason(intent.plan.planId)}`,
      );
    }
    const { facts, itinerary, officialRevision } = journey;
    const matchRows = facts.pool.map((item) => ({
      flyaiId: item.id,
      category: item.category ?? null,
      rating: item.rating ?? null,
    }));
    return shapeJourney({
      itinerary,
      cityName: journey.cityName,
      matchRows,
      stopId: intent.stopId,
      interests: intent.interests,
      // 会话与去重键都带上 plan 与角色：A 与 B 各用各的上下文，永远拿不到对方的会话
      itineraryKey: agentScopeKey(intent.plan.planId, intent.plan.role, `v${officialRevision}|${keyOf(itinerary.stops)}`),
      notInRouteMessage:
        `选中的站点不在双方确认的正式行程里（收到 id「${String(intent.stopId).slice(0, 24)}」），` +
        `当前正式版本是 v${officialRevision}，请重新选择。`,
    });
  }

  const city = pickCity(intent.cityName);
  if (!city) {
    throw new AgentRefused(
      `本阶段只支持杭州，收到的 cityName 是「${String(intent.cityName ?? "空").slice(0, 20)}」。`,
    );
  }

  const report = await verifyRoute(city, intent.categories);
  if (!report.ok || !report.itinerary) {
    throw new AgentRefused(
      report.error ??
        report.insufficiency ??
        "服务端还没有拿到经过高德核实的行程，请先点「校验真实路线」。",
    );
  }
  return shapeJourney({
    itinerary: report.itinerary,
    cityName: report.cityName,
    matchRows: report.matches.map((match) => ({
      flyaiId: match.flyaiId,
      category: match.category,
      rating: match.amap?.rating ?? null,
    })),
    stopId: intent.stopId,
    interests: intent.interests,
    itineraryKey: keyOf(report.itinerary.stops),
  });
}

/* ── 方案 A：服务端把已核实数据结构化后喂给智能体 ──────────────────── */

interface AgentContext {
  block: string;
  /** 同一份行程的同一份数据；热会话里第二次回合用它判断是否可以不再发一遍 */
  fingerprint: string;
  factMeters: number[];
  factMinutes: number[];
}

type MatchRow = MatchRowLite;

const MATCH_LABEL: Record<MatchStatus, string> = {
  matched: "高德已匹配",
  suspicious: "坐标可疑",
  unverified: "未核实",
};

const OPENING_LABEL: Record<OpeningStatus, string> = {
  "open-24h": "24小时开放",
  "no-conflict": "与拟定时间不冲突",
  conflict: "开放时间冲突",
  unknown: "未核实",
};

/** 只有当前这一站给完整资料：智能体要对它说话，其余各站只需要名字与实测。 */
function currentStopBlock(stop: VerifiedStop, match: MatchRow | null): string {
  const bits = [
    `名称 ${stop.name}`,
    match?.category ? `类别 ${match.category}` : null,
    stop.address ? `地址 ${stop.address}` : null,
    match?.rating ? `高德评分 ${match.rating}` : null,
    `站点核对 ${MATCH_LABEL[stop.matchStatus]}`,
    `开放时间 ${OPENING_LABEL[stop.openingStatus]}`,
    stop.flyaiDescription ? `飞猪简介 ${stop.flyaiDescription.slice(0, 80)}` : null,
    `计划停留 ${stop.stayMinutes} 分钟`,
  ].filter((bit): bit is string => Boolean(bit));
  return `【当前位置】${bits.join("｜")}`;
}

function buildContext(journey: ResolvedJourney): AgentContext {
  const matchById = new Map(journey.matchRows.map((match) => [match.flyaiId, match]));
  const factMeters: number[] = [];
  const factMinutes: number[] = [BUDGET_MINUTES, journey.elapsedMinutes, journey.remainingMinutes];

  const walked = journey.visited.filter((stop) => stop.flyaiId !== journey.current.flyaiId);
  const currentIndex = journey.stops.findIndex((stop) => stop.flyaiId === journey.current.flyaiId);

  /** 只给「从当前位置往后还会走」的实测段；起点段与已走过的段对本轮决策没有用 */
  const futureLegs = journey.legs.slice(currentIndex + 1);
  const legLines = futureLegs.map((leg) => {
    factMeters.push(leg.distanceMeters);
    factMinutes.push(leg.durationMinutes);
    return `${leg.fromName}→${leg.toName} ${leg.distanceMeters}米/${leg.durationMinutes}分钟`;
  });

  const candidateLines = journey.remaining.map((stop) => {
    const match = matchById.get(stop.flyaiId) ?? null;
    const bits = [
      stop.name,
      match?.category ?? null,
      match?.rating ? `评分${match.rating}` : null,
      `停留${stop.stayMinutes}分钟`,
    ].filter(Boolean);
    return bits.join(" ");
  });

  const itinerary = journey.itinerary;
  factMeters.push(itinerary.totalWalkMeters);
  factMinutes.push(itinerary.totalWalkMinutes, itinerary.totalMinutes);

  const block = [
    `【城市】${journey.cityName}·${VERIFY_DISTRICT}`,
    `【兴趣】${journey.interests.join("、") || "未填写"}`,
    `【旅行状态】预算 ${BUDGET_MINUTES} 分钟，已用约 ${journey.elapsedMinutes} 分钟，剩余 ${journey.remainingMinutes} 分钟`,
    `【已走过】${walked.map((stop) => stop.name).join("、") || "（还没有）"}`,
    currentStopBlock(journey.current, matchById.get(journey.current.flyaiId) ?? null),
    `【还没走的站】${candidateLines.join("；") || "（全部走完）"}`,
    legLines.length ? `【高德步行实测，只能照抄这些数字】${legLines.join("；")}` : "【高德步行实测】后面没有步行段了",
  ].join("\n");

  return {
    block,
    fingerprint: createHash("sha1").update(block).digest("hex").slice(0, 16),
    factMeters,
    factMinutes,
  };
}

/**
 * 会话历史里已经有同一份数据时不再重发。
 * 这不是省略证据：数据仍在同一条百炼会话的上下文中，
 * 且智能体给出的站点与数字都还要过高德复验与逐字对账。
 */
function contextForTurn(known: boolean, context: AgentContext): string {
  return known ? "（沿用本会话上一条消息里的【已核实数据】，行程没有变化。）" : context.block;
}

/* ── Prompt ─────────────────────────────────────────────────────── */

function explorePrompt(
  journey: ResolvedJourney,
  context: AgentContext,
  dataKnown: boolean,
): string {
  const unvisitedNames = journey.remaining.map((stop) => stop.name).join("、") || "（无）";
  return [
    `用户刚到达「${journey.current.name}」，给此刻的在场讲解与下一步建议。`,
    "",
    contextForTurn(dataKnown, context),
    "",
    `【下一步候选】只能选这一个未走的站：${unvisitedNames}。全部走完时 next 写「返回起点」。`,
    '输出 JSON：{"headline":"不超过100字的现场介绍","details":["最多3条值得留意的观察，每条不超过40字"],"next":"一条下一步建议，不超过50字；引用距离时间时照抄实测值"}',
    "details 写成引导注意力的句子（例如「留意……」），不要写成事实断言；数据支撑不足时就少写一条。",
  ].join("\n");
}

function shortenPrompt(
  journey: ResolvedJourney,
  context: AgentContext,
  failure: string | null,
  dataKnown: boolean,
): string {
  const remainingNames = journey.remaining.map((stop) => stop.name).join("、");
  return [
    "用户说：少走一点。只从下面这些【还没走】的已核实站点里删减，给出更短的后续方案。不需要重新讲解当前景点，也不要输出距离或时间数字（那些由服务端实测后展示）。",
    "",
    contextForTurn(dataKnown, context),
    "",
    `【可调整的站点】${remainingNames || "（没有未走的站可调整）"}`,
    "已走过的站不要出现在 stops 里；stops 的数量必须比可调整数量至少少一个，否则不算「少走一点」。",
    failure ? `【上一个方案未通过校验】${failure} 请换一个更省时间的方案。` : "",
    '输出 JSON：{"stops":["新顺序的站点名，必须与上面的 name 完全一致"],"reason":"一句话说明为什么这样删"}',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/* ── 回合 → 凭证 ────────────────────────────────────────────────── */

function makeProof(
  config: BailianConfig,
  sessionId: string,
  turns: TurnResult[],
  overrides: string[],
): AgentCallProof {
  const last = turns[turns.length - 1];
  const usage = turns.reduce(
    (total, turn) => ({
      modelRequests: total.modelRequests + turn.usage.modelRequests,
      inputTokens: total.inputTokens + turn.usage.inputTokens,
      outputTokens: total.outputTokens + turn.usage.outputTokens,
      cacheReadTokens: total.cacheReadTokens + turn.usage.cacheReadTokens,
    }),
    { modelRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  );
  return {
    invokedAt: turns[0]?.invokedAt ?? new Date().toISOString(),
    durationMs: turns.reduce((sum, turn) => sum + turn.durationMs, 0),
    hostMasked: `${maskId(config.workspace)}.${config.region}.maas.aliyuncs.com`,
    agentIdMasked: maskId(config.agentId),
    environmentIdMasked: maskId(config.environmentId),
    sessionIdMasked: maskId(sessionId),
    apiCalls: turns.reduce((sum, turn) => sum + turn.apiCalls, 0),
    eventCount: turns.reduce((sum, turn) => sum + turn.eventCount, 0),
    modelTurns: turns.length,
    howItEnded: last?.howItEnded ?? "unknown",
    stopReason: last?.stopReason ?? null,
    replyChars: last?.replyText.length ?? 0,
    usage,
    toolEvents: turns.flatMap((turn) => turn.toolEvents),
    flyaiToolCalled: turns.some((turn) =>
      turn.toolEvents.some((event) => /fly|飞猪|feizhu|poi/i.test(event.name)),
    ),
    latency: last?.latency ?? null,
    latencyPerTurn: turns.map((turn) => turn.latency),
    sessionOverrides: overrides,
    resolvedModels: [...new Set(turns.map((turn) => turn.resolvedModel).filter((m): m is string => Boolean(m)))],
  };
}

function turnFailure(turn: TurnResult): string | null {
  if (turn.error) return turn.error;
  if (turn.howItEnded === "timeout") {
    return `等待智能体回复超时（约 ${Math.round(turn.durationMs / 1000)} 秒），已中止本次回合。`;
  }
  if (turn.howItEnded !== "status") return `事件流异常结束（${turn.howItEnded}），没有收到会话空闲回执。`;
  if (!turn.replyText) return "智能体没有返回任何文本。";
  return null;
}

/* ── 我到了 ─────────────────────────────────────────────────────── */

export function exploreWithAgent(
  intent: JourneyIntent,
  clientToken: string | null,
  options: { onDelta?: (text: string) => void } = {},
): Promise<ExploreResponse> {
  const dedupeKey = intent.plan
    ? agentTurnKey(intent.plan.planId, intent.plan.role, "explore", "scoped", intent.stopId ?? "")
    : `explore|${clientToken ?? "new"}|${intent.stopId ?? ""}`;
  const pending = turnTasks.get(dedupeKey);
  if (pending) return pending as Promise<ExploreResponse>;

  const task = (async (): Promise<ExploreResponse> => {
    const base: ExploreResponse = {
      ok: false,
      error: null,
      stopName: null,
      arrivalMode: ARRIVAL_MODE,
      narration: null,
      proof: null,
      token: clientToken,
    };
    try {
      const config = requireConfig();
      // 超限的请求连会话都不建：不能拿注定失败的请求去刷百炼的会话配额
      const cap = turnCapMessage();
      if (cap) throw new AgentRefused(cap);
      const journey = await resolveJourney(intent);
      const context = buildContext(journey);
      const session = await getOrCreateSession(config, journey.itineraryKey, clientToken);
      const dataKnown = session.contextFingerprint === context.fingerprint;
      // 双人模式下会话由服务端按 plan+角色 持有，浏览器不需要也不该拿到作用域键
      const echoToken = intent.plan ? null : session.token;

      const turn = await runTurn(
        config,
        session.sessionId,
        explorePrompt(journey, context, dataKnown),
        { timeoutMs: EXPLORE_TIMEOUT_MS, onDelta: options.onDelta },
      );
      if (!dataKnown && messageAccepted(turn)) markContextSent(session.token, context.fingerprint);
      const proof = makeProof(config, session.sessionId, [turn], session.overrides);

      const failure = turnFailure(turn);
      if (failure) {
        return {
          ...base,
          token: echoToken,
          error: failure,
          stopName: journey.current.name,
          proof,
        };
      }
      const narration = auditNumericClaims(
        toNarration(parseJsonObject(turn.replyText), turn.replyText),
        context.factMeters,
        context.factMinutes,
      );
      return {
        ...base,
        ok: true,
        token: echoToken,
        stopName: journey.current.name,
        narration,
        proof,
      };
    } catch (caught) {
      return { ...base, error: message(caught) };
    }
  })();

  turnTasks.set(dedupeKey, task);
  return task.finally(() => turnTasks.delete(dedupeKey));
}

/* ── 少走一点：智能体提议 → 服务端用高德实测校验 ─────────────────────── */

interface ReplanResult {
  itinerary: VerifiedItinerary | null;
  error: string | null;
}

/**
 * 已走过的站连同它们的历史实测段原样保留，只重排还没走的部分；
 * 新产生的每一段都必须由高德 /v5/direction/walking 实测拿到，测不到就拒绝采用。
 */
async function replan(journey: ResolvedJourney, proposedNames: string[]): Promise<ReplanResult> {
  if (journey.remaining.length === 0) {
    return { itinerary: null, error: "已核实行程已经全部走到，没有可删减的站点。" };
  }

  const chosen: VerifiedStop[] = [];
  for (const raw of proposedNames) {
    const name = String(raw ?? "").trim();
    const hit = journey.remaining.find((stop) => stop.name === name);
    if (!hit) {
      return {
        itinerary: null,
        error: `智能体给出的「${name.slice(0, 30)}」不在已核实行程里，无法核验，已拒绝采用。`,
      };
    }
    if (!chosen.some((stop) => stop.flyaiId === hit.flyaiId)) chosen.push(hit);
  }

  if (chosen.length === 0) return { itinerary: null, error: "智能体没有给出任何有效站点。" };
  if (chosen.length >= journey.remaining.length) {
    return {
      itinerary: null,
      error: `智能体一个站点都没少走（仍然 ${chosen.length} 站），不符合「少走一点」。`,
    };
  }

  const newLegs: WalkingLeg[] = [];
  let cursor = journey.current.position;
  let cursorName = journey.current.name;

  for (const stop of chosen) {
    const measured = await planWalking(cursor, stop.position);
    if (!measured.ok || !measured.data) {
      return {
        itinerary: null,
        error: `高德实测「${cursorName} → ${stop.name}」这一段失败：${measured.error ?? "无返回"}，不能采用。`,
      };
    }
    const leg = toLeg(cursorName, stop.name, cursor, stop.position, measured.data, measured.entry.fromCache);
    newLegs.push(leg);
    cursor = stop.position;
    cursorName = stop.name;
  }

  const itinerary = composeItinerary(
    journey.itinerary.start,
    [...journey.visited, ...chosen],
    [...journey.historyLegs, ...newLegs],
    assumedTripWindow(new Date()).startAt,
  );

  if (!itinerary.feasible) {
    return {
      itinerary: null,
      error: `调整后高德实测总时长 ${itinerary.totalMinutes} 分钟（步行 ${itinerary.totalWalkMinutes}＋停留 ${itinerary.totalStayMinutes}＋余量 ${itinerary.bufferMinutes}），仍超出 ${BUDGET_MINUTES} 分钟预算。`,
    };
  }
  return { itinerary, error: null };
}

/**
 * 两份高德实测行程相减。已走过的段在两边完全相同，所以差值恰好就是被删掉的那些段，
 * 不存在「智能体少报了」的空间。负数一律压成 0，避免出现「少走一点反而更远」。
 */
function savingsOf(before: VerifiedItinerary, after: VerifiedItinerary): RouteSavings {
  return {
    fromStops: before.stops.length,
    toStops: after.stops.length,
    savedMeters: Math.max(0, before.totalWalkMeters - after.totalWalkMeters),
    savedWalkMinutes: Math.max(0, before.totalWalkMinutes - after.totalWalkMinutes),
    savedTotalMinutes: Math.max(0, before.totalMinutes - after.totalMinutes),
  };
}

/** 消息没被服务端受理时，上下文其实没进会话，下一回合必须重发。 */
function messageAccepted(turn: TurnResult): boolean {
  return turn.howItEnded !== "post-failed";
}

/**
 * 调整后的行程里还有哪些事项没核实过。全部从已核实字段推导，
 * 不让智能体自己声明「都核实了」。
 */
function unverifiedNotesOf(itinerary: VerifiedItinerary | null): string[] {
  if (!itinerary) return [];
  const notes: string[] = [];
  for (const stop of itinerary.stops) {
    if (stop.matchStatus !== "matched") {
      notes.push(`${stop.name}：${MATCH_LABEL[stop.matchStatus]}`);
    }
    if (stop.openingStatus === "unknown" || stop.openingStatus === "conflict") {
      notes.push(`${stop.name}：开放时间${OPENING_LABEL[stop.openingStatus]}`);
    }
  }
  return notes;
}

export function shortenWithAgent(
  intent: JourneyIntent,
  clientToken: string | null,
  options: { onDelta?: (text: string) => void } = {},
): Promise<AdjustResponse> {
  const dedupeKey = `shorten|${clientToken ?? "new"}|${intent.stopId ?? ""}`;
  const pending = turnTasks.get(dedupeKey);
  if (pending) return pending as Promise<AdjustResponse>;

  const task = (async (): Promise<AdjustResponse> => {
    const base: AdjustResponse = {
      ok: false,
      error: null,
      proposedNames: [],
      agentReason: null,
      droppedNames: [],
      unverifiedNotes: [],
      itinerary: null,
      validationError: null,
      firstAttemptFailure: null,
      retried: false,
      amapNewCalls: 0,
      savings: null,
      baseItineraryKey: null,
      proof: null,
      token: clientToken,
    };
    try {
      const config = requireConfig();
      // 超限的请求连会话都不建：不能拿注定失败的请求去刷百炼的会话配额
      const cap = turnCapMessage();
      if (cap) throw new AgentRefused(cap);
      const journey = await resolveJourney(intent);
      const context = buildContext(journey);
      const session = await getOrCreateSession(config, journey.itineraryKey, clientToken);

      const walkingBefore = amapCounters().walkingCalls;
      let names: string[] = [];
      let reason: string | null = null;
      let replanResult: ReplanResult | null = null;
      let failure: string | null = null;
      let firstAttemptFailure: string | null = null;
      const turns: TurnResult[] = [];
      let retried = false;
      let dataKnown = session.contextFingerprint === context.fingerprint;

      // 最多两轮：第一轮的方案没通过高德校验，就把失败原因回灌再问一次
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const turn = await runTurn(
          config,
          session.sessionId,
          shortenPrompt(journey, context, failure, dataKnown),
          { timeoutMs: SHORTEN_TIMEOUT_MS, onDelta: options.onDelta },
        );
        turns.push(turn);
        if (!dataKnown && messageAccepted(turn)) {
          markContextSent(session.token, context.fingerprint);
          dataKnown = true;
        }
        failure = turnFailure(turn);
        if (failure) break;

        const data = parseJsonObject(turn.replyText);
        names = Array.isArray(data?.stops)
          ? (data!.stops as unknown[]).map((item) => String(item ?? "").trim()).filter(Boolean)
          : [];
        reason = typeof data?.reason === "string" ? data.reason.trim() : null;

        if (names.length === 0) {
          failure = `智能体没有按格式返回 stops 数组（回复 ${turn.replyText.length} 字）。`;
        } else {
          replanResult = await replan(journey, names);
          failure = replanResult.error;
        }

        if (!failure) break;
        if (attempt === 0) {
          retried = true;
          firstAttemptFailure = failure;
        }
      }

      const ok = Boolean(replanResult?.itinerary) && !failure;
      const kept = new Set((replanResult?.itinerary?.stops ?? []).map((stop) => stop.flyaiId));
      return {
        ...base,
        ok,
        token: session.token,
        error: ok ? null : failure ?? "调整失败。",
        proposedNames: names,
        agentReason: reason,
        droppedNames: journey.remaining
          .filter((stop) => !kept.has(stop.flyaiId))
          .map((stop) => stop.name),
        unverifiedNotes: ok ? unverifiedNotesOf(replanResult!.itinerary) : [],
        itinerary: replanResult?.itinerary ?? null,
        validationError: replanResult?.error ?? null,
        firstAttemptFailure,
        retried,
        amapNewCalls: amapCounters().walkingCalls - walkingBefore,
        savings: ok ? savingsOf(journey.itinerary, replanResult!.itinerary!) : null,
        baseItineraryKey: ok ? journey.itineraryKey : null,
        proof: turns.length ? makeProof(config, session.sessionId, turns, session.overrides) : null,
      };
    } catch (caught) {
      return { ...base, error: message(caught) };
    }
  })();

  turnTasks.set(dedupeKey, task);
  return task.finally(() => turnTasks.delete(dedupeKey));
}

/* ── 双人协商：让 AI 解释这次取舍 ─────────────────────────────────── */

const EXPLAIN_TIMEOUT_MS = 90_000;

/** 模型只能在这些动作里挑；文案与补测报价由服务端回填，所以它编不出新动作。 */
function explainPrompt(brief: ReturnType<typeof buildNegotiationBrief>): string {
  const options = brief.options.map((option) => `- ${option.key}：${option.text}`).join("\n");
  return [
    "两个人对同一条杭州半日路线各自提了条件，服务端已经算出结论。请解释这次取舍，并给出下一步建议。",
    "",
    brief.block,
    "",
    "【服务端允许的下一步（只能引用下面的 key）】",
    options || "-（服务端没有给出可选动作）",
    "",
    "【必须遵守】",
    "1. 可行性、距离、耗时、硬约束是否满足都由服务端判定；上面的数字只能原样照抄，不得新增、换算或相加。",
    "2. 不得替任何一方同意，不得劝任何一方放宽底线；条件只能由当事人自己在界面上提交。",
    "3. 下一步建议只能从上面的 key 里挑，不合适的可以不挑。",
    "4. 数据里没有的价格、门票、开放时间细节、历史故事一律不提；确实要提就说「数据未提供，需现场核实」。",
    "5. 还没实测的站不能说「走不到」，只能说「没有实测依据，需要先补测」。",
    "",
    "只输出一个 JSON 对象：",
    '{"summary":"一句话说明这次为什么这样取舍","points":["…"],"nextSteps":[{"key":"…","why":"…"}],"cautions":["…"]}',
  ].join("\n");
}

function clampList(value: unknown, max: number, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, max)
    .map((item) => item.trim().slice(0, limit));
}

export function explainNegotiation(
  input: { planId: string; role: Role },
  options: { onDelta?: (text: string) => void } = {},
): Promise<NegotiationExplainResponse> {
  const dedupeKey = agentTurnKey(input.planId, input.role, "explain", "scoped", "current");
  const pending = turnTasks.get(dedupeKey);
  if (pending) return pending as Promise<NegotiationExplainResponse>;

  const task = (async (): Promise<NegotiationExplainResponse> => {
    /** 内部作用域键不外传，外传的是它的短哈希：足以证明两角色各用各的会话 */
    let scopeKey = "";
    const maskedScope = () => (scopeKey ? createHash("sha1").update(scopeKey).digest("hex").slice(0, 12) : null);
    const base: NegotiationExplainResponse = {
      ok: false,
      error: null,
      summary: null,
      points: [],
      nextSteps: [],
      cautions: [],
      rejectedKeys: [],
      revision: null,
      audit: null,
      proof: null,
      scopeKey: null,
    };
    try {
      const config = requireConfig();
      const cap = turnCapMessage();
      if (cap) throw new AgentRefused(cap);

      const source = planForBrief(input.planId);
      if (!source) {
        throw new AgentRefused(
          "这条协商的事实层已失效（服务重启、已撤销或超出保留期）。需要重新核验一次才能解释，我不会拿旧结论冒充真实结果。",
        );
      }
      const revision = headRevisionOf(source.state);
      const brief = buildNegotiationBrief({ facts: source.facts, state: source.state, revision });
      const fingerprint = createHash("sha1").update(brief.block).digest("hex").slice(0, 16);
      scopeKey = agentScopeKey(
        input.planId,
        input.role,
        revision ? `v${revision.revision}|${revision.contentHash}` : "no-revision",
      );
      const session = await getOrCreateSession(config, scopeKey, null, scopeKey);
      const dataKnown = session.contextFingerprint === fingerprint;

      const turn = await runTurn(
        config,
        session.sessionId,
        explainPrompt(brief),
        { timeoutMs: EXPLAIN_TIMEOUT_MS, onDelta: options.onDelta },
      );
      if (!dataKnown && messageAccepted(turn)) markContextSent(session.token, fingerprint);
      const proof = makeProof(config, session.sessionId, [turn], session.overrides);

      const failure = turnFailure(turn);
      if (failure) {
        return { ...base, error: failure, proof, revision: revision?.revision ?? null, scopeKey: maskedScope() };
      }

      const parsed = parseJsonObject(turn.replyText);
      const allowed = new Map(brief.options.map((option) => [option.key, option]));
      const rawSteps = Array.isArray(parsed?.nextSteps) ? parsed.nextSteps : [];
      const nextSteps: NegotiationExplainResponse["nextSteps"] = [];
      const rejectedKeys: string[] = [];
      for (const item of rawSteps.slice(0, 6)) {
        const key = typeof (item as { key?: unknown })?.key === "string" ? String((item as { key: string }).key) : "";
        const option = allowed.get(key);
        if (!option) {
          if (key) rejectedKeys.push(key.slice(0, 40));
          continue;
        }
        nextSteps.push({
          key: option.key,
          text: option.text,
          extraCalls: option.extraCalls,
          why: typeof (item as { why?: unknown }).why === "string" ? String((item as { why: string }).why).slice(0, 160) : null,
        });
      }

      const summary = typeof parsed?.summary === "string" ? parsed.summary.trim().slice(0, 240) : null;
      const points = clampList(parsed?.points, 6, 160);
      const cautions = clampList(parsed?.cautions, 4, 160);
      if (!summary && !points.length) {
        return {
          ...base,
          error: "智能体没有给出可用的解释文本（服务端没有替它编一段话），规则求解结果仍然按原样显示。",
          proof,
          revision: revision?.revision ?? null,
          scopeKey: maskedScope(),
        };
      }
      const audit = auditNumericClaims(
        {
          headline: summary ?? "",
          details: [...points, ...cautions],
          nextSuggestion: nextSteps.map((step) => step.why ?? "").join(" "),
          degraded: false,
          rawText: turn.replyText,
          numericAudit: { claims: [], matched: 0, unmatched: [] },
        },
        brief.factMeters,
        brief.factMinutes,
      ).numericAudit;

      return {
        ok: true,
        error: null,
        summary,
        points,
        nextSteps,
        cautions,
        rejectedKeys,
        revision: revision?.revision ?? null,
        audit,
        proof,
        scopeKey: maskedScope(),
      };
    } catch (caught) {
      return { ...base, error: message(caught), scopeKey: maskedScope() };
    }
  })();

  turnTasks.set(dedupeKey, task);
  return task.finally(() => turnTasks.delete(dedupeKey));
}

/* ── 服务端状态 ─────────────────────────────────────────────────── */

function requireConfig(): BailianConfig {
  const config = readBailianConfig();
  if (!config) {
    throw new AgentRefused(
      `服务端缺少环境变量：${missingBailianVars().join("、")}，已拒绝调用百炼（不会用 Mock 结果代替）。`,
    );
  }
  return config;
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export async function agentServerStatus(): Promise<AgentServerStatus> {
  const config = readBailianConfig();
  const counters = bailianCounters();
  let profile: AgentProfile | null = null;
  let profileError: string | null = null;

  if (config) {
    const fetched = await fetchAgentProfile(config);
    profile = fetched.profile;
    profileError = fetched.error;
  }

  return {
    configComplete: Boolean(config),
    missingVars: missingBailianVars(),
    keyPresent: Boolean(config),
    keyMask: config ? maskKey(config.key) : null,
    region: config?.region ?? "cn-beijing",
    hostMasked: config ? `${maskId(config.workspace)}.${config.region}.maas.aliyuncs.com` : "—",
    agentIdMasked: config ? maskId(config.agentId) : null,
    environmentIdMasked: config ? maskId(config.environmentId) : null,
    profile,
    profileError,
    activeSessions: sessions.size,
    sessionTtlSeconds: SESSION_TTL_MS / 1000,
    turnTimeoutSeconds: EXPLORE_TIMEOUT_MS / 1000,
    totalApiCalls: counters.totalApiCalls,
    totalTurns: counters.totalTurns,
    statusReads: counters.statusReads,
    turnsLastHour: counters.turnsLastHour,
    turnHourlyCap: counters.turnHourlyCap,
    usage: counters.usage,
    log: counters.log,
    serverTime: new Date().toISOString(),
    pid: process.pid,
  };
}
