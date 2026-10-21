import { pickCity } from "@/lib/discovery";
import { amapServerStatus, verifyRoute } from "@/lib/server/verify";
import { VERIFY_CATEGORIES } from "@/lib/verification";
import { connection } from "next/server";

interface VerifyRequestBody {
  cityName?: unknown;
}

/**
 * 服务端状态。cacheComponents 下 GET 会被预渲染，
 * 必须 await connection() 才能让 key 与调用计数按请求实时读取。
 */
export async function GET() {
  await connection();
  return Response.json(amapServerStatus());
}

/**
 * 跑完整核验流水线：飞猪候选 → 坐标系判定 → 高德 POI 比对 →
 * 真实步行路径 → 四小时可行性组合。
 * 一次调用会真实请求高德数十次，所以结果整体缓存，重复点击零成本。
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  let body: VerifyRequestBody | null = null;
  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as VerifyRequestBody;
    } catch {
      return Response.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
    }
  }

  const cityName = pickCity(body?.cityName);
  if (!cityName) {
    const received = String(body?.cityName ?? "空").slice(0, 40);
    return Response.json(
      { error: `本阶段只支持杭州，收到的 cityName 是「${received}」。` },
      { status: 400 },
    );
  }

  const report = await verifyRoute(cityName);
  return Response.json({ report, categories: [...VERIFY_CATEGORIES] });
}
