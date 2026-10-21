import { fetchRouteGeometry } from "@/lib/server/route-geometry";

/**
 * 地图上要画的每一段步行路线，若报告里没有道路几何就来这里补查。
 * 只接受坐标对，返回同样按下标对齐的 polyline；命中服务端缓存时零高德调用。
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { legs: [], newCalls: 0, cacheHits: 0, error: "请求体不是合法 JSON。" },
      { status: 400 },
    );
  }

  const result = await fetchRouteGeometry(body);
  return Response.json(result, { status: result.error ? 400 : 200 });
}
