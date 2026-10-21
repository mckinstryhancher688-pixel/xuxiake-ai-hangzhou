import { DISCOVER_ENDPOINT } from "@/lib/discovery";
import type { DiscoverBatch } from "@/lib/types";
import { sleep } from "./sleep";
import type { AdapterMeta, FlyAiClient, FlyAiSearchResult } from "./types";

const MOCK_LATENCY_MS = 300;

const META: AdapterMeta = {
  source: "live",
  note:
    "第二阶段已接入（仅 search-poi）。浏览器只请求本站 POST /api/discover，由服务端 spawn flyai CLI；" +
    "FLYAI_API_KEY 只存在于服务端 .env.local，不进入客户端 bundle。" +
    "每次调用的耗时、退出码与缓存命中情况见「重新发现」面板；ai-search 仍是 Mock。",
};

const MOCK_AI_SEARCH_MARKDOWN = `## 演示语义搜索结果

这是一段**预写的 Mock 文案**，用来占位飞猪 \`ai-search\` 的真实返回。

- 真实调用返回的是 Markdown 字符串，不是结构化列表
- 接入后需要在服务端把 Markdown 解析成卡片，或直接渲染
- 本阶段不发起任何网络请求`;

export function createFlyAiClient(): FlyAiClient {
  return {
    meta: META,

    async searchPoi(query): Promise<DiscoverBatch> {
      const response = await fetch(DISCOVER_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cityName: query.cityName, categories: query.categories }),
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`服务端 ${DISCOVER_ENDPOINT} 返回 HTTP ${response.status}：${text.slice(0, 300)}`);
      }

      let parsed: { batch?: DiscoverBatch; error?: string };
      try {
        parsed = JSON.parse(text) as { batch?: DiscoverBatch; error?: string };
      } catch {
        throw new Error(`服务端 ${DISCOVER_ENDPOINT} 返回的不是合法 JSON：${text.slice(0, 200)}`);
      }
      if (!parsed.batch) {
        throw new Error(parsed.error ?? `服务端 ${DISCOVER_ENDPOINT} 的响应里没有 batch 字段。`);
      }
      return parsed.batch;
    },

    async aiSearch(): Promise<FlyAiSearchResult<{ markdown: string }>> {
      // ── REAL 接入点（后续阶段替换）：服务端 flyai ai-search --query "<自然语言>" ──
      await sleep(MOCK_LATENCY_MS);
      return {
        meta: { source: "mock", note: "未接入。ai-search 返回预写 Markdown，不发起网络请求。" },
        items: [{ markdown: MOCK_AI_SEARCH_MARKDOWN }],
      };
    },
  };
}
