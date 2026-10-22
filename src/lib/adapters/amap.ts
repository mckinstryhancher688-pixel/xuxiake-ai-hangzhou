import type { FlyAiPoiCategory } from "@/lib/discovery";
import { VERIFY_ENDPOINT } from "@/lib/verification";
import type { VerifyReport } from "@/lib/types";
import type { AdapterMeta, AmapClient } from "./types";

const META: AdapterMeta = {
  source: "live",
  note:
    "第三阶段已接入（POI 搜索 2.0 + 步行路径规划 2.0），第六阶段起步行结果还带真实道路折线。" +
    "浏览器只请求本站 POST /api/verify 与 POST /api/route-geometry，由服务端携带 AMAP_WEB_KEY 调用" +
    " restapi.amap.com；key 不进入客户端 bundle，任何日志与返回值都不含 key，也不含带 key 的完整请求 URL。" +
    "真实底图另用高德「Web端(JS API)」类型的 AMAP_JS_KEY，安全密钥只由本站 /_AMapService 代理在服务端补上、" +
    "浏览器拿不到；两项缺任何一项，地图就退回手绘示意底图并明确标注。",
};

export function createAmapClient(): AmapClient {
  return {
    meta: META,

    async verifyRoute(cityName: string, categories?: FlyAiPoiCategory[]): Promise<VerifyReport> {
      const response = await fetch(VERIFY_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cityName, ...(categories ? { categories } : {}) }),
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `服务端 ${VERIFY_ENDPOINT} 返回 HTTP ${response.status}：${text.slice(0, 300)}`,
        );
      }

      let parsed: { report?: VerifyReport; error?: string };
      try {
        parsed = JSON.parse(text) as { report?: VerifyReport; error?: string };
      } catch {
        throw new Error(`服务端 ${VERIFY_ENDPOINT} 返回的不是合法 JSON：${text.slice(0, 200)}`);
      }
      if (!parsed.report) {
        throw new Error(parsed.error ?? `服务端 ${VERIFY_ENDPOINT} 的响应里没有 report 字段。`);
      }
      return parsed.report;
    },
  };
}
