import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    // 本机一次性产物（Playwright 截图、PR 草稿、评测 JSON），不是应用源码，不参与 lint
    "output/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
