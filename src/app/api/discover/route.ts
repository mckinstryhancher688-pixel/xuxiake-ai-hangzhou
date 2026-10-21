import {
  DEFAULT_DISCOVER_CATEGORIES,
  FLYAI_POI_CATEGORIES,
  MAX_CATEGORIES_PER_CALL,
  parseCategories,
  pickCity,
} from "@/lib/discovery";
import { discoverCity, discoverStatus } from "@/lib/server/discover";
import { connection } from "next/server";

interface DiscoverRequestBody {
  cityName?: unknown;
  categories?: unknown;
}

/**
 * 服务端状态。cacheComponents 下 GET 会被预渲染，
 * 必须 await connection() 才能让 key/缓存/调用计数按请求实时读取。
 */
export async function GET() {
  await connection();
  return Response.json(discoverStatus());
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  let body: DiscoverRequestBody | null = null;
  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as DiscoverRequestBody;
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

  const requested = body?.categories;
  const categories =
    requested === undefined || requested === null
      ? [...DEFAULT_DISCOVER_CATEGORIES]
      : parseCategories(requested);
  if (!categories.length) {
    return Response.json(
      {
        error: `categories 里没有任何受支持的类别（单次最多 ${MAX_CATEGORIES_PER_CALL} 个）。可用类别：${FLYAI_POI_CATEGORIES.join("、")}。`,
      },
      { status: 400 },
    );
  }

  const batch = await discoverCity(cityName, categories);
  return Response.json({ batch });
}
