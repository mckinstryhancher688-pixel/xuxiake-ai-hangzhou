import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  async rewrites() {
    // 高德 JS API 安全代理的固定一级路由必须是 _AMapService（官方文档：不可省略或修改），
    // 而 App Router 里下划线开头的目录是私有目录、不参与路由，所以只能由路由改写到真实 handler。
    // 浏览器地址栏与 SDK 看到的仍然是 /_AMapService/…，守卫逻辑全在 /amap-proxy 那一个 handler 里。
    return [
      {
        source: "/_AMapService/:path*",
        destination: "/amap-proxy/:path*",
      },
    ];
  },
  outputFileTracingIncludes: {
    // flyai CLI 是运行时按文件路径 spawn 的子进程入口，依赖追踪看不见它；
    // 不显式带上，云端函数里就没有这个文件，「重新发现」会在部署环境失败。
    "/api/discover": ["./node_modules/@fly-ai/flyai-cli/**"],
    "/api/trips/[[...path]]": ["./node_modules/@fly-ai/flyai-cli/**"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
