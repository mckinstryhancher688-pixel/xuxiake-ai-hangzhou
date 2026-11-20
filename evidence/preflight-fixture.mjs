/**
 * 可渲染的夹具报告（形状复用 source-evidence-browser-probe.mjs 里通过 14/14 浏览器回归的那份）。
 * 仅用于验证「出门前先问」的界面与重解接线，不代表真实路线；带上 factsId 只为触发重解。
 */
const START = {
  name: "湖滨公园（夹具）",
  amapId: "amap-start",
  address: "杭州市上城区（夹具）",
  position: { lat: 30.255, lng: 120.155 },
  reason: "夹具：与真实流程相同的固定起点设定",
};

function stop(id, name, lat, lng, extra = {}) {
  return {
    name,
    flyaiId: id,
    amapId: `amap-${id}`,
    address: "杭州市上城区（夹具）",
    position: { lat, lng },
    matchStatus: "matched",
    stayMinutes: 30,
    staySource: "simulated",
    openingStatus: "no-conflict",
    openingNote: "夹具：按假定窗口不冲突",
    jumpUrl: null,
    flyaiDescription: null,
    flyaiMainPic: null,
    flyaiFreeStatus: null,
    flyaiCollectedAt: "2026-11-15T02:00:00.000Z",
    flyaiIdFromSource: true,
    ...extra,
  };
}

function leg(fromName, toName, from, to) {
  return {
    fromName,
    toName,
    from,
    to,
    distanceMeters: 1200,
    durationMinutes: 5,
    durationSeconds: 300,
    stepCount: 0,
    firstInstruction: null,
    fromCache: true,
    // 两点直线占位：让几何补查为空，从而 0 次 route-geometry POST
    polyline: [from, to],
  };
}

function match(item) {
  return {
    flyaiId: item.flyaiId,
    name: item.name,
    category: "文创街区",
    flyaiAddress: item.address,
    flyaiPosition: item.position,
    jumpUrl: null,
    flyaiDescription: null,
    status: "matched",
    reason: null,
    amap: {
      id: item.amapId, name: item.name, address: item.address, adname: "上城区",
      typecode: null, position: item.position, opentime: null, rating: null,
    },
    deviationMeters: 0,
    routablePosition: item.position,
    nameAgrees: true,
    addressAgrees: true,
    districtAgrees: true,
    openingStatus: "no-conflict",
    openingNote: "夹具：按假定窗口不冲突",
    routable: true,
    routableReason: "夹具",
    flyaiCollectedAt: item.flyaiCollectedAt,
    flyaiIdFromSource: true,
  };
}

/**
 * 第二站的实景图与收费状态取自真实 /api/discover 返回（见 evidence/flyai-photo-accept.json，
 * 原 POI 为「良渚文化村」，freePoiStatus 原值为 UNKNOWN，另取「南山路」验证 UNKNOWN 不显示徽标）。
 * 只有这两个字段是真的；行程、步行段与站名仍是夹具，别把这份快照当真实路线。
 */
const REAL_MAINPIC =
  "https://img.alicdn.com/imgextra/i2/6000000006215/O1CN01nIyfwC1vmWQQWUaFY_!!6000000006215-0-fliggyimage.jpg";

const STOPS = [
  // 第一站：飞猪没给图 + 标了 FREE → 应画占位块并显示「免费」徽标
  stop("a", "桩站点A（夹具）", 30.256, 120.154, { flyaiMainPic: null, flyaiFreeStatus: "FREE" }),
  // 第二站：真实图 + UNKNOWN → 应画出 <img>，且不得显示「免费」
  stop("b", "桩站点B（夹具）", 30.257, 120.153, { flyaiMainPic: REAL_MAINPIC, flyaiFreeStatus: "UNKNOWN" }),
];

const LEGS = [
  leg(START.name, STOPS[0].name, START.position, STOPS[0].position),
  leg(STOPS[0].name, STOPS[1].name, STOPS[0].position, STOPS[1].position),
];

export const FIXTURE_REPORT = {
  cityName: "杭州",
  districtName: "西湖湖滨",
  budgetMinutes: 240,
  generatedAt: "2026-11-15T02:00:00.000Z",
  ok: true,
  error: null,
  categories: ["自然风光"],
  candidateCount: 2,
  datum: { probes: [], flyaiDatum: null, reason: "夹具：样本不足，不下坐标系结论" },
  start: START,
  matches: STOPS.map(match),
  matchedCount: 2,
  suspiciousCount: 0,
  unverifiedCount: 0,
  routableCount: 2,
  itinerary: {
    start: START,
    stops: STOPS,
    legs: LEGS,
    totalWalkMeters: 2600,
    totalWalkMinutes: 45,
    totalStayMinutes: 60,
    bufferMinutes: 20,
    totalMinutes: 125,
    budgetMinutes: 240,
    feasible: true,
    assumedStartAt: "2026-11-15T02:00:00.000Z",
  },
  insufficiency: null,
  rejections: [],
  amap: {
    keyPresent: true, keyMask: "夹具****", placeCalls: 0, walkingCalls: 0,
    cacheHits: 0, failedCalls: 0, placeHourlyCap: 40, walkingHourlyCap: 80,
    cacheTtlSeconds: 21600, log: [],
  },
  flyaiProofs: [],
  // 无障碍洗手间：只给第一站一条，用来验证「有就显示、没有就不显示」
  toilets: {
    cityName: "杭州",
    found: 2,
    nearest: [
      { anchorName: "桩站点A（夹具）", toiletName: "无障碍洗手间(夹具)", straightLineMeters: 120, address: "夹具地址", amapId: "t1" },
    ],
    anchorsWithoutToilet: ["湖滨公园（起点）", "桩站点B（夹具）"],
    newCalls: 0,
    fromCache: true,
    note: "夹具：口径说明文字由 TOILET_SCOPE_NOTE 提供",
  },
  // 只为触发重解接线；真实核验里这个 id 来自服务端事实层
  facts: {
    factsId: "stub-facts",
    cityName: "杭州",
    categories: ["自然风光"],
    poolSize: 2,
    measuredPairs: 2,
    startLegs: 2,
    failedPairs: 0,
    measuredAt: "2026-11-15T02:00:00.000Z",
  },
};

export const FIXTURE_SNAPSHOT = {
  cityName: "杭州",
  report: FIXTURE_REPORT,
  usedCategories: ["自然风光"],
};
