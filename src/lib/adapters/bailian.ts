import { MOCK_EXPLORATIONS } from "@/data/mock";
import type { ExplorationContent } from "@/lib/types";
import { sleep } from "./sleep";
import type { AdapterMeta, BailianAgent } from "./types";

/** 让 Mock 也有可感知的延迟，避免第二阶段接真接口时才发现加载态没做。 */
const MOCK_LATENCY_MS = 450;

const META: AdapterMeta = {
  source: "mock",
  note: "未接入。探索内容来自 src/data/mock/explorations.ts 的预写文案。",
};

function emptyExploration(poiId: string): ExplorationContent {
  return {
    poiId,
    arrivedHeadline: "（这个地点还没有预写探索内容）",
    discoveries: ["Mock 数据缺少该 POI 的文案，接入百炼后由模型实时生成。"],
    photoTip: "—",
    askNext: [],
    source: "mock",
  };
}

export function createBailianAgent(): BailianAgent {
  return {
    meta: META,
    async explore({ poi }) {
      // ── REAL 接入点（第二阶段替换这里）──────────────────────────
      // 必须放在服务端 route handler（如 src/app/api/explore/route.ts）里调用，
      // 密钥只读服务端 env，不能进客户端包：
      //   POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
      //   Authorization: Bearer ${BAILIAN_API_KEY}
      //   model: qwen-plus / qwen-max，或百炼控制台创建的 Managed Agent 应用 ID
      // prompt 里带上 context（city / interests）、remainingMinutes 与 poi 全文，
      // 返回值仍映射成 ExplorationContent，UI 层不用改。
      // ───────────────────────────────────────────────────────────
      await sleep(MOCK_LATENCY_MS);
      return MOCK_EXPLORATIONS[poi.id] ?? emptyExploration(poi.id);
    },
  };
}
