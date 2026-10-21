import { proxyAmapRequest } from "@/lib/server/amap-js";
import { connection } from "next/server";

/**
 * 高德 JS API 的安全密钥代理：SDK 的 web 服务请求打到这里，
 * 服务端补 jscode 后转发高德上游。浏览器拿不到安全密钥本身。
 */
async function forward(
  request: Request,
  params: Promise<{ path?: string[] }>,
): Promise<Response> {
  await connection();
  const { path } = await params;
  return proxyAmapRequest(request, path ?? []);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  return forward(request, params);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  return forward(request, params);
}
