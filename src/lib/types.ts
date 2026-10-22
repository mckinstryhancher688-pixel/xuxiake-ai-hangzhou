export type DataSource = "mock" | "live";

export interface LatLng {
  lat: number;
  lng: number;
}

export type PoiCategory = "quiet-street" | "nature" | "culture" | "landmark";

export interface Poi {
  id: string;
  name: string;
  subtitle: string;
  category: PoiCategory;
  position: LatLng;
  /** 建议停留分钟数（演示估算） */
  stayMinutes: number;
  /** 开放情况文字，未核实的一律显式写出 */
  opening: string;
  openingVerified: boolean;
  tags: string[];
  /** 推荐理由 */
  reason: string;
  /** 一个有趣的发现 */
  discovery: string;
  source: DataSource;
}

export type WalkMode = "walk" | "metro";

export interface RouteLeg {
  fromId: string;
  toId: string;
  mode: WalkMode;
  minutes: number;
  distanceMeters: number;
  note?: string;
}

export type RouteVariant = "standard" | "short";

export interface JourneyRoute {
  id: RouteVariant;
  label: string;
  summary: string;
  poiIds: string[];
  legs: RouteLeg[];
  totalWalkMeters: number;
  totalMinutes: number;
  source: DataSource;
}

export interface ExplorationContent {
  poiId: string;
  arrivedHeadline: string;
  discoveries: string[];
  photoTip: string;
  askNext: string[];
  source: DataSource;
}

export interface JourneyContext {
  city: string;
  district: string;
  interests: string[];
  budgetCny: number;
  totalMinutes: number;
}

/* ── 第二阶段：飞猪 FlyAI 真实 POI 的统一结构 ───────────────────────── */

/** 飞猪原始返回里可能缺失、必须在 UI 上明示的字段。 */
export type DiscoveredPoiMissingField =
  | "id"
  | "address"
  | "category"
  | "position"
  | "jumpUrl"
  | "description";

export interface DiscoveredPoi {
  id: string;
  name: string;
  address: string | null;
  category: string | null;
  /** 飞猪原样返回的经纬度；缺失或非法时为 null */
  position: LatLng | null;
  /**
   * 字面量 false：第二阶段没有任何坐标核实手段，类型层面就禁止声称已核实。
   * 第三阶段接入高德地理编码/路径规划后才允许变成 boolean。
   */
  coordinatesVerified: false;
  jumpUrl: string | null;
  description: string | null;
  source: DataSource;
  missingFields: DiscoveredPoiMissingField[];
}

/** 一次真实 CLI 调用的凭证，用于在服务端之外也能核对调用确实发生过。 */
export interface FlyAiCallProof {
  invokedAt: string;
  durationMs: number;
  /** Windows 上 CLI 退出时会触发 libuv 断言，退出码非 0 但 stdout 仍有效，所以只作参考 */
  exitCode: number | null;
  /** 已脱敏，不含 FLYAI_API_KEY 的值 */
  command: string;
  cliEntry: string;
  keySource: "env:FLYAI_API_KEY";
  stdoutBytes: number;
  rawItemCount: number;
  cacheHit: boolean;
}

export interface DiscoverCategoryResult {
  category: string;
  items: DiscoveredPoi[];
  /** null 表示该类别调用成功且有数据 */
  error: string | null;
  proof: FlyAiCallProof | null;
}

export type DiscoverOrigin = "flyai-live" | "mock-fallback";

export interface DiscoverBatch {
  cityName: string;
  /** 服务端返回的一律是 flyai-live；只有用户主动切换演示数据时才是 mock-fallback */
  origin: DiscoverOrigin;
  fetchedAt: string;
  /** 至少一个类别拿到真实数据 */
  ok: boolean;
  error: string | null;
  results: DiscoverCategoryResult[];
}

/* ── 第三阶段：高德地理验证与四小时路线可行性校验 ───────────────────── */

export type CoordinateDatum = "gcj02" | "wgs84";

/** 一个地标的两种坐标系假设各自的偏差，用来判定飞猪到底用哪个坐标系。 */
export interface DatumProbe {
  landmarkName: string;
  flyaiPosition: LatLng;
  amapPosition: LatLng;
  /** 假设一：飞猪本来就是 GCJ-02 → 原样比对的偏差 */
  asGcj02Meters: number;
  /** 假设二：飞猪是 WGS-84 → 先转 GCJ-02 再比对的偏差 */
  asWgs84Meters: number;
}

export interface DatumConclusion {
  probes: DatumProbe[];
  /** 证据支持的飞猪坐标系；样本不足或两种假设无法区分时为 null */
  flyaiDatum: CoordinateDatum | null;
  reason: string;
}

export type MatchStatus = "matched" | "suspicious" | "unverified";

/** 高德侧返回并被采纳的那个 POI，全部是实测字段，缺失就是 null。 */
export interface AmapPoi {
  id: string;
  name: string;
  address: string | null;
  /** 区县，例如 西湖区 */
  adname: string | null;
  typecode: string | null;
  /** 高德坐标，GCJ-02 */
  position: LatLng;
  /** business.opentime_today 原样文本；高德没给就是 null */
  opentime: string | null;
  rating: string | null;
}

export type OpeningStatus = "open-24h" | "no-conflict" | "conflict" | "unknown";

export interface CandidateMatch {
  flyaiId: string;
  name: string;
  category: string | null;
  flyaiAddress: string | null;
  flyaiPosition: LatLng | null;
  jumpUrl: string | null;
  /** 飞猪原样返回的简介文本；第四阶段把它连同高德实测值一起喂给智能体，缺失就是 null */
  flyaiDescription: string | null;
  status: MatchStatus;
  /** 未匹配 / 可疑的具体原因，绝不省略 */
  reason: string | null;
  amap: AmapPoi | null;
  /** 采用结论坐标系换算后的偏差；无法比对时为 null */
  deviationMeters: number | null;
  /** 高德返回的坐标（GCJ-02），路径规划只用这个，不用飞猪的 */
  routablePosition: LatLng | null;
  /** 名称/地址/区县三项各自是否吻合，用于展示核验依据 */
  nameAgrees: boolean | null;
  addressAgrees: boolean | null;
  districtAgrees: boolean | null;
  openingStatus: OpeningStatus;
  openingNote: string;
  /** 可疑但身份可确认（仅飞猪标点偏移）时仍允许参与路径规划，理由写在这里 */
  routable: boolean;
  routableReason: string;
}

/**
 * 浏览器加载真实高德底图所需的配置。安全密钥本身从不出现在这里，
 * 只给出服务端代理地址，由代理补 jscode。
 */
export interface MapJsConfig {
  ready: boolean;
  /** JS API Key（Web端 key）；未配置或与 Web 服务 key 撞车时为 null */
  jsKey: string | null;
  /** SDK 的 web 服务请求走这里，jscode 只在这个地址背后被补上 */
  securityHost: string;
  jsKeyMask: string | null;
  securityCodePresent: boolean;
  /** 缺了哪几项，前端据此回退到明确标记的演示地图 */
  missing: string[];
}

export interface RouteStart {
  name: string;
  amapId: string;
  address: string | null;
  position: LatLng;
  /** 为什么选它当起点 */
  reason: string;
}

/** 按需补查步行折线：客户端只交出地图上要画的几段，服务端按段查高德并缓存。 */
export interface GeometryLegRequest {
  from: LatLng;
  to: LatLng;
}

export interface GeometryLegOutcome {
  /** 与请求数组下标一一对应，客户端不用猜坐标键格式 */
  index: number;
  polyline: LatLng[];
  fromCache: boolean;
  distanceMeters: number | null;
  error: string | null;
}

export interface GeometryResponse {
  legs: GeometryLegOutcome[];
  /** 本次真实发起的高德步行路径规划次数，命中缓存为 0 */
  newCalls: number;
  cacheHits: number;
  error: string | null;
}

/** 一段真实步行路径，全部数值来自高德 /v5/direction/walking。 */
export interface WalkingLeg {
  fromName: string;
  toName: string;
  from: LatLng;
  to: LatLng;
  distanceMeters: number;
  durationMinutes: number;
  durationSeconds: number;
  stepCount: number;
  firstInstruction: string | null;
  fromCache: boolean;
  /**
   * 高德 steps[].polyline 拼起来的真实道路折线（GCJ-02）。
   * 高德偶发不返回几何时为 []，地图此时只能不画这段，绝不退化成两点直线。
   */
  polyline: LatLng[];
}

/** 行程里的一站：地点信息来自飞猪+高德，停留时间是模拟值。 */
export interface VerifiedStop {
  name: string;
  flyaiId: string;
  amapId: string;
  address: string | null;
  position: LatLng;
  matchStatus: MatchStatus;
  /** 模拟值，不是飞猪也不是高德给的 */
  stayMinutes: number;
  staySource: "simulated";
  openingStatus: OpeningStatus;
  openingNote: string;
  jumpUrl: string | null;
  /** 飞猪给的简介文本（未经核实的事实性文字），只作为智能体的语料，不在前端当结论展示 */
  flyaiDescription: string | null;
}

export interface VerifiedItinerary {
  start: RouteStart;
  stops: VerifiedStop[];
  /** start→stop1、stop1→stop2 …… 与 stops 一一对应，长度 = stops.length */
  legs: WalkingLeg[];
  totalWalkMeters: number;
  totalWalkMinutes: number;
  totalStayMinutes: number;
  bufferMinutes: number;
  totalMinutes: number;
  budgetMinutes: number;
  feasible: boolean;
  /** 假定出发时间，营业时间冲突判定以此为基准 */
  assumedStartAt: string;
}

export interface AmapCallLogEntry {
  at: string;
  api: "place/text" | "direction/walking";
  /** 已脱敏的查询参数，不含 key */
  params: string;
  httpStatus: number | null;
  infocode: string | null;
  info: string | null;
  durationMs: number;
  /** 因限流(infocode 10021)退避重试过几次；0 表示一次就成功 */
  retries: number;
  fromCache: boolean;
  error: string | null;
}

export interface AmapUsage {
  keyPresent: boolean;
  keyMask: string | null;
  placeCalls: number;
  walkingCalls: number;
  cacheHits: number;
  failedCalls: number;
  placeHourlyCap: number;
  walkingHourlyCap: number;
  cacheTtlSeconds: number;
  log: AmapCallLogEntry[];
}

export interface VerifyReport {
  cityName: string;
  districtName: string;
  budgetMinutes: number;
  generatedAt: string;
  ok: boolean;
  error: string | null;
  /** 飞猪候选来自哪些类别 */
  categories: string[];
  candidateCount: number;
  datum: DatumConclusion;
  start: RouteStart | null;
  matches: CandidateMatch[];
  matchedCount: number;
  suspiciousCount: number;
  unverifiedCount: number;
  /** 坐标已核实、可用于步行路径规划的条数 */
  routableCount: number;
  itinerary: VerifiedItinerary | null;
  /** 合格地点不足时的显式说明；不允许用假地点凑数 */
  insufficiency: string | null;
  /** 被排除的地点及原因，让「为什么是这几个」可追溯 */
  rejections: { name: string; reason: string }[];
  amap: AmapUsage;
  flyaiProofs: FlyAiCallProof[];
  /**
   * 事实层入库摘要。核验时已经付费测出的有向段全部留在服务端事实库里，
   * 双人协商只在这批数据上本地重解；报告里只带计数与 factsId，不带明细。
   */
  facts?: {
    factsId: string;
    cityName: string;
    categories: string[];
    /** 可点选全集：身份已核验且有高德坐标的候选数（含最近 6 个之外的） */
    poolSize: number;
    measuredPairs: number;
    startLegs: number;
    failedPairs: number;
    measuredAt: string;
  };
}

/* ── 第四阶段：百炼 Managed Agent（在场探索与动态调整）───────────────── */

export interface TokenUsage {
  /** 本轮 model_request_end 事件数，一次用户指令可能触发多次模型请求 */
  modelRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface AgentToolEvent {
  /** 工具名，例如 bash */
  name: string;
  callIdMasked: string | null;
  isError: boolean;
  /** 已脱敏并截断的入参；百炼返回的 arguments 本身是 JSON 字符串 */
  argumentsPreview: string | null;
  outputPreview: string | null;
}

/** 一次真实百炼调用的凭证。所有 ID 已脱敏，绝不包含 DASHSCOPE_API_KEY。 */
/** 一次回合的延迟分解：把「等百炼」拆开，避免把所有延迟都算成 prompt 太长。 */
export interface AgentTurnLatency {
  /** 发起请求 → SSE 建连（拿到响应头）；这段时间里包含平台为会话准备沙箱/路由 */
  streamConnectedMs: number | null;
  /** 发起请求 → 收到第一个可解析事件帧 */
  firstEventMs: number | null;
  /** 发起请求 → 收到第一个内容增量（真正开始出字，可能是思考） */
  firstDeltaMs: number | null;
  /** 发起请求 → 第一个「答案流」增量：网页上真正能开始显示文字的时刻 */
  firstAnswerDeltaMs: number | null;
  /** 发起请求 → 用户消息被服务端受理（入队，不代表开始生成） */
  postedMs: number;
  /** 消息受理 → 第一个内容增量：这一段才是排队 + 模型首字 */
  queueMs: number | null;
  /** 第一个内容增量 → 回合结束：模型生成本身耗时 */
  generationMs: number | null;
  totalMs: number;
  /** 本次回合实际发出的 HTTP 请求数（SSE 订阅 + 消息提交 = 2） */
  httpAttempts: number;
  /** 网络层重试次数；当前实现不重试，如实为 0 */
  httpRetries: number;
  /** 增量事件按流类型的字符数，用来区分「思考」和「答案」；unknown 表示平台没给出可识别的流类型 */
  streamKinds: string;
  promptChars: number;
  reasoningChars: number;
  answerChars: number;
}

export interface AgentCallProof {
  invokedAt: string;
  durationMs: number;
  hostMasked: string;
  agentIdMasked: string;
  environmentIdMasked: string;
  sessionIdMasked: string;
  apiCalls: number;
  eventCount: number;
  /** 实际向智能体问了几轮：重问一次就多一整轮 token，必须如实计入 */
  modelTurns: number;
  /** 回合结束方式：status=正常结束，timeout/stream-end/stream-failed 都是异常 */
  howItEnded: string;
  stopReason: string | null;
  replyChars: number;
  usage: TokenUsage;
  toolEvents: AgentToolEvent[];
  /** 本回合是否调用过名字含 fly/飞猪/poi 的工具；第四阶段服务端喂数据，预期为 false */
  flyaiToolCalled: boolean;
  /** 多轮时取最后一轮的延迟分解，另附各轮耗时 */
  latency: AgentTurnLatency | null;
  latencyPerTurn: AgentTurnLatency[];
  /** 会话创建时实际下发的覆盖项，用来证明内置工具确实被摘掉了 */
  sessionOverrides: string[];
  /** AUTO 在本回合实际选中的千问模型（来自 model_request_end 事件，非猜测） */
  resolvedModels: string[];
}

/** 智能体回复里出现的数字，与高德实测值逐条比对，用来证明它没编数字。 */
export interface NumericClaimAudit {
  /** 回复文本里出现的全部「数字 + 米/分钟」量度 */
  claims: { text: string; value: number; unit: "meters" | "minutes" }[];
  matched: number;
  unmatched: string[];
}

export interface AgentNarration {
  /** 此刻在场的开场，≤40 字 */
  headline: string;
  /** 2–3 条值得注意的细节 */
  details: string[];
  /** 下一步探索建议 */
  nextSuggestion: string;
  /** 解析不出 JSON 时为 true，前端要明示这是原文兜底 */
  degraded: boolean;
  /** 模型原话，用于对照 */
  rawText: string;
  numericAudit: NumericClaimAudit;
}

/** 本阶段没有真实定位，到达一律是模拟点击；UI 必须这样标注。 */
export type ArrivalMode = "simulated";

/**
 * 双人协商的「让 AI 解释这次取舍」。
 *
 * 模型只拿到服务端已经算好的事实块，输出也只允许复述与挑选：
 * nextSteps 的文案与补测报价都由服务端按 key 回填，模型编出来的 key 会被直接丢掉。
 */
export interface NegotiationExplainResponse {
  ok: boolean;
  /** 失败时是服务端原话；此时界面必须继续显示规则求解结果，不能拿固定文案冒充 AI */
  error: string | null;
  summary: string | null;
  points: string[];
  nextSteps: { key: string; text: string; extraCalls: number | null; why: string | null }[];
  cautions: string[];
  /** 被模型提出但服务端没有这个选项的 key，如实列出来，不静默吞掉 */
  rejectedKeys: string[];
  /** 解释针对的是哪一版；版本变了这份解释就该重做 */
  revision: number | null;
  /** 数字对账：不在事实块里的米/分钟一律标出来 */
  audit: NumericClaimAudit | null;
  proof: AgentCallProof | null;
  /** 会话作用域（plan + 角色 + 版本的脱敏键），证明两角色各用各的会话 */
  scopeKey: string | null;
}

export interface ExploreResponse {
  ok: boolean;
  error: string | null;
  /** 本次讲解针对的站点 */
  stopName: string | null;
  arrivalMode: ArrivalMode;
  narration: AgentNarration | null;
  proof: AgentCallProof | null;
  /** 服务端会话票据；浏览器只存它，真实 Session ID 从不出服务端 */
  token: string | null;
}

export interface AdjustResponse {
  ok: boolean;
  error: string | null;
  /** 智能体提议的新顺序，用站点名表示 */
  proposedNames: string[];
  agentReason: string | null;
  /** 被删掉的站（服务端算出来的，不让智能体自己声明） */
  droppedNames: string[];
  /** 调整后的行程里仍未核实的事项（站点匹配可疑、开放时间未核实等） */
  unverifiedNotes: string[];
  /** 只有高德实测通过的行程才会出现在这里；未通过时为 null */
  itinerary: VerifiedItinerary | null;
  /** 验证不通过的明确原因，绝不静默丢弃 */
  validationError: string | null;
  /** 第一次方案被高德否掉的原因；重问成功后也要能看到它 */
  firstAttemptFailure: string | null;
  /** 是否因为第一次校验失败而向智能体重问了一次 */
  retried: boolean;
  /** 本回合高德新发起了几次真实请求（命中缓存为 0） */
  amapNewCalls: number;
  /** 与调整前那一份高德实测路线的差值；方案未通过校验时为 null */
  savings: RouteSavings | null;
  /**
   * 这份方案是在哪一条已核实路线上提出的（各站 flyaiId 拼出来的键）。
   * 重新核验换了路线之后，旧方案就不再适用，靠它判定要不要丢弃。
   */
  baseItineraryKey: string | null;
  proof: AgentCallProof | null;
  token: string | null;
}

/**
 * 「少走一点」到底省下了什么。三个数都由服务端拿两份高德实测行程相减得到，
 * 不让智能体自己报数——它报的距离与耗时一律不进这里。
 */
export interface RouteSavings {
  fromStops: number;
  toStops: number;
  savedMeters: number;
  savedWalkMinutes: number;
  savedTotalMinutes: number;
}

/**
 * POST /api/agent 以 text/event-stream 返回时的三种帧。
 * delta 是智能体正在真实生成的文字（未校验，只用于「已经出字了」的进度反馈）；
 * result 才是服务端复验过、可以展示为结论的数据。
 */
export type AgentStreamFrame =
  | { type: "delta"; text: string }
  | { type: "result"; response: ExploreResponse | AdjustResponse };

/** GET /api/agent 返回的 Agent 配置摘要；全部字段来自百炼 GET /agents/{id}，且已脱敏。 */
export interface AgentProfile {
  name: string | null;
  version: number | null;
  modelId: string | null;
  /** 思考模式是延迟的最大头，必须能在页面上看到它的真实开关状态 */
  enableThinking: boolean | null;
  thinkingBudget: number | null;
  maxTokens: number | null;
  enabledTools: string[];
  skillCount: number;
  mcpServerCount: number;
}

export interface AgentServerStatus {
  configComplete: boolean;
  missingVars: string[];
  keyPresent: boolean;
  keyMask: string | null;
  region: string;
  hostMasked: string;
  agentIdMasked: string | null;
  environmentIdMasked: string | null;
  /** 读取 Agent 配置那一次调用的结果；失败时为 null，不影响对话 */
  profile: AgentProfile | null;
  profileError: string | null;
  /** 服务端当前持有的活动会话数（浏览器只拿到票据） */
  activeSessions: number;
  sessionTtlSeconds: number;
  turnTimeoutSeconds: number;
  totalApiCalls: number;
  totalTurns: number;
  /** 读取 Agent 配置那类 GET 的次数：不产生 token 费用，不能混进「调用次数」里 */
  statusReads: number;
  /** 本小时已用掉多少个付费回合，以及上限（公开部署后的止损阀门） */
  turnsLastHour: number;
  turnHourlyCap: number;
  usage: TokenUsage;
  log: AgentCallLogEntry[];
  serverTime: string;
  pid: number;
}

export interface AgentCallLogEntry {
  at: string;
  method: "GET" | "POST";
  /** 已脱敏的路径，不含 key，ID 只留头尾 */
  path: string;
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
}
