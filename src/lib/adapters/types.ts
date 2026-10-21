import type {
  DataSource,
  DiscoverBatch,
  ExplorationContent,
  JourneyContext,
  Poi,
  VerifyReport,
} from "@/lib/types";

/** 每个适配器都要自报数据来源，UI 用它来决定是否显示「演示数据」标记。 */
export interface AdapterMeta {
  source: DataSource;
  /** 一句话说明当前状态与真实接入位置 */
  note: string;
}

export interface ExploreRequest {
  poi: Poi;
  context: JourneyContext;
  /** 由已完成的停留与步行时间派生，不是独立状态 */
  remainingMinutes: number;
}

/** 百炼千问 Agent：负责「我到了」之后的在场探索内容生成。 */
export interface BailianAgent {
  readonly meta: AdapterMeta;
  explore(request: ExploreRequest): Promise<ExplorationContent>;
}

export interface FlyAiPoiQuery {
  cityName: string;
  /** 白名单里的类别，见 src/lib/discovery.ts；每多一个类别服务端多一次真实调用 */
  categories: string[];
}

export interface FlyAiSearchResult<T> {
  meta: AdapterMeta;
  items: T[];
}

/** 飞猪 FlyAI：负责 POI / 酒店 / 语义搜索，对应 flyai CLI 的各子命令。 */
export interface FlyAiClient {
  readonly meta: AdapterMeta;
  /**
   * 走站内服务端 POST /api/discover（由服务端 spawn flyai search-poi），
   * 返回统一结构的真实 POI 批次，含每次调用的凭证与失败原因。
   * 传输层失败会 throw，业务层失败体现在 batch.ok / batch.error。
   */
  searchPoi(query: FlyAiPoiQuery): Promise<DiscoverBatch>;
  aiSearch(query: string): Promise<FlyAiSearchResult<{ markdown: string }>>;
}

/**
 * 高德 Web 服务 API：第三阶段只用到 POI 搜索 2.0 与步行路径规划 2.0，
 * 两者都在服务端由 /api/verify 统一调用，浏览器拿到的是一份核验报告。
 */
export interface AmapClient {
  readonly meta: AdapterMeta;
  /**
   * 触发完整核验流水线：飞猪候选 → 坐标系判定 → 高德 POI 比对 →
   * 真实步行路径 → 四小时可行性组合。
   * 一次调用会让服务端真实请求高德数十次，服务端整体缓存结果，重复调用零成本。
   */
  verifyRoute(cityName: string): Promise<VerifyReport>;
}