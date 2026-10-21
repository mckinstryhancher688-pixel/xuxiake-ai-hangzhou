import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  outputFileTracingIncludes: {
    // flyai CLI 是运行时按文件路径 spawn 的子进程入口，依赖追踪看不见它；
    // 不显式带上，云端函数里就没有这个文件，「重新发现」会在部署环境失败。
    "/api/discover": ["./node_modules/@fly-ai/flyai-cli/**"],
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
