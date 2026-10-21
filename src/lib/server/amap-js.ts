import type { MapJsConfig } from "@/lib/types";

if (typeof window !== "undefined") {
  throw new Error("lib/server/amap-js 只能在 Next.js 服务端加载。");
}

/**
 * 高德地图 JS API 2.0 的凭证管理（第六阶段）。
 *
 * 三件事必须分开：
 *  1. AMAP_WEB_KEY   —— 服务端 Web 服务 key，只给 /v5/place、/v5/direction 用（lib/server/amap.ts）。
 *  2. AMAP_JS_KEY    —— JS API key，浏览器加载底图必须带它，配合控制台域名白名单才有效。
 *     它是「前端可见」的，但绝不与 Web 服务 key 混用：混用会得到 USERKEY_PLAT_NOMATCH，
 *     本模块在两者相同直接判定为配置错误。
 *  3. AMAP_JS_SECURITY_CODE —— 安全密钥。绝不进浏览器，也不作为 NEXT_PUBLIC 变量。
 *     SDK 的 web 服务请求改走本项目的 /amap-proxy 代理，由服务端在这里补 jscode。
 */

export const MAP_PROXY_PREFIX = "/amap-proxy";

const REST_API_HOST = "https://restapi.amap.com";
const WEB_API_HOST = "https://webapi.amap.com";
/** 只放行这几个版本前缀，避免本服务变成任意 URL 的开放代理。 */
const ALLOWED_PREFIXES = new Set(["v3", "v4", "v5"]);
const SEGMENT_PATTERN = /^[A-Za-z0-9._@-]+$/;
const PROXY_TIMEOUT_MS = 12_000;
/** 代理是给这一个页面用的，被刷就没有意义了；每分钟上限守住配额。 */
const PROXY_MINUTE_CAP = 240;
/** 高德 SDK 走代理的 POST 都是小请求；不限体积的话这里会变成上传中继。 */
const PROXY_MAX_BODY_BYTES = 256 * 1024;
const proxyStamps: number[] = [];

export function readJsApiKey(): string | null {
  return process.env.AMAP_JS_KEY?.trim() || null;
}

export function readJsSecurityCode(): string | null {
  return process.env.AMAP_JS_SECURITY_CODE?.trim() || null;
}

function mask(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-2)}`;
}

/**
 * 浏览器加载真实地图所需的全部信息。key 缺失时 ready=false，
 * 前端据此回退到明确标记的演示地图，而不是拿假底图冒充。
 */
export function mapJsConfig(): MapJsConfig {
  const jsKey = readJsApiKey();
  const securityCode = readJsSecurityCode();
  const webKey = process.env.AMAP_WEB_KEY?.trim() || null;

  const missing: string[] = [];
  if (!jsKey) missing.push("AMAP_JS_KEY（高德 JS API Key）");
  if (!securityCode) missing.push("AMAP_JS_SECURITY_CODE（高德 JS API 安全密钥）");
  if (jsKey && webKey && jsKey === webKey) {
    missing.push("AMAP_JS_KEY 与 AMAP_WEB_KEY 是同一个 key：JS API 必须单独申请 Web端 key");
  }

  return {
    ready: missing.length === 0,
    jsKey: jsKey && jsKey !== webKey ? jsKey : null,
    // 相对路径：由浏览器按自己的 origin 解析。服务端猜 origin 会踩
    // localhost / 127.0.0.1 不一致的坑，SDK 的请求就变成跨域了。
    securityHost: MAP_PROXY_PREFIX,
    jsKeyMask: mask(jsKey),
    securityCodePresent: Boolean(securityCode),
    missing,
  };
}

function scrub(text: string, secret: string | null): string {
  return secret ? text.split(secret).join("<hidden>") : text;
}

function upstreamHost(segments: string[]): string {
  // 官方 nginx 样例：样式服务在 webapi，其余走 restapi
  return segments[0] === "v4" && segments[1] === "map" ? WEB_API_HOST : REST_API_HOST;
}

/**
 * 高德 SDK 的安全密钥代理。浏览器只看到 /amap-proxy/v3/... 这样的同源地址，
 * jscode 在这里才拼进上游 URL，响应与错误文本都做了脱敏。
 */
export async function proxyAmapRequest(
  request: Request,
  segments: string[],
): Promise<Response> {
  const json = (status: number, error: string) =>
    Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

  if (!segments.length || segments.some((s) => !SEGMENT_PATTERN.test(s))) {
    return json(400, "高德代理拒绝了非法的路径片段。");
  }
  // `..` 能通过字符校验，但会把 URL 归一化回上游根路径，等于绕开版本前缀白名单。
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return json(400, "高德代理拒绝了带有点段的路径。");
  }
  if (!ALLOWED_PREFIXES.has(segments[0])) {
    return json(400, `高德代理只转发 ${[...ALLOWED_PREFIXES].join("/")} 开头的请求。`);
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return json(405, "高德代理只接受 GET / POST。");
  }
  // 带 key 的请求必须是本站自己的 JS key：否则任何人都能拿这个端点当免费的高德转发器，
  // 用别人的 key + 我们的安全密钥去调高德。
  const incoming = new URL(request.url);
  const claimedKey = incoming.searchParams.get("key");
  if (claimedKey && claimedKey !== readJsApiKey()) {
    return json(403, "高德代理拒绝了不属于本站 JS API Key 的请求。");
  }

  // 体积检查放在配额计数之前：被拒的大请求不该消耗本站的转发额度。
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > PROXY_MAX_BODY_BYTES) {
    return json(413, `高德代理只转发不超过 ${PROXY_MAX_BODY_BYTES / 1024} KB 的请求体。`);
  }

  const now = Date.now();
  while (proxyStamps.length && proxyStamps[0] < now - 60_000) proxyStamps.shift();
  if (proxyStamps.length >= PROXY_MINUTE_CAP) {
    return json(429, `高德代理本分钟请求数已达上限（${PROXY_MINUTE_CAP} 次）。`);
  }
  proxyStamps.push(now);

  const secret = readJsSecurityCode();
  if (!secret) return json(500, "服务端没有读到 AMAP_JS_SECURITY_CODE，无法为请求补安全密钥。");

  const target = new URL(`${upstreamHost(segments)}/${segments.join("/")}`);
  for (const [name, value] of incoming.searchParams.entries()) {
    if (name === "jscode") continue; // 只认服务端的环境变量，不接受浏览器传来的
    target.searchParams.set(name, value);
  }
  target.searchParams.set("jscode", secret);

  const init: RequestInit = {
    method: request.method,
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    redirect: "manual",
  };
  if (request.method === "POST") {
    const raw = await request.arrayBuffer();
    // content-length 可以撒谎，落到真实字节数再判一次
    if (raw.byteLength > PROXY_MAX_BODY_BYTES) {
      return json(413, `高德代理只转发不超过 ${PROXY_MAX_BODY_BYTES / 1024} KB 的请求体。`);
    }
    init.body = raw;
    const contentType = request.headers.get("content-type");
    if (contentType) init.headers = { "content-type": contentType };
  }

  try {
    const upstream = await fetch(target, init);
    const body = await upstream.arrayBuffer();
    const headers = new Headers({
      "cache-control": "no-store",
      "content-type":
        upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
    });
    return new Response(body, { status: upstream.status, headers });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return json(502, `高德代理请求上游失败：${scrub(message, secret).slice(0, 200)}`);
  }
}

/** 调试面板用的状态；只输出掩码，绝不输出明文。 */
export function mapProxyCounters(): {
  requestsLastMinute: number;
  minuteCap: number;
} {
  const now = Date.now();
  while (proxyStamps.length && proxyStamps[0] < now - 60_000) proxyStamps.shift();
  return { requestsLastMinute: proxyStamps.length, minuteCap: PROXY_MINUTE_CAP };
}
