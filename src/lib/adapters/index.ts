import { createAmapClient } from "./amap";
import { createBailianAgent } from "./bailian";
import { createFlyAiClient } from "./flyai";

export * from "./types";
export { createBailianAgent, createFlyAiClient, createAmapClient };

/**
 * 三个外部依赖各自独立，互不引用。
 * 第二阶段接真实 API 时只改对应 factory 内部实现，调用方不动。
 */
export function createAdapters() {
  return {
    bailian: createBailianAgent(),
    flyai: createFlyAiClient(),
    amap: createAmapClient(),
  };
}

export type Adapters = ReturnType<typeof createAdapters>;
