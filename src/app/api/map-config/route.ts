import { mapJsConfig } from "@/lib/server/amap-js";
import { connection } from "next/server";

/**
 * 前端加载高德 JS API 2.0 前的配置检查。
 * cacheComponents 下 GET 会被预渲染，await connection() 才能让 env 按请求实时读取。
 */
export async function GET() {
  await connection();
  return Response.json(mapJsConfig(), {
    headers: { "cache-control": "no-store" },
  });
}
