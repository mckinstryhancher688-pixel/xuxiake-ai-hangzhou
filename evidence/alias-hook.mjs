import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 让 Node 直接跑 src 下的 TypeScript：
 *   1. 把 tsconfig 的 "@/*" 别名映射到 ./src/*；
 *   2. 补上打包器会自动加、Node 却要求写全的 `.ts` 扩展名。
 *
 * 只解析路径，不改代码：类型剥离仍用 Node 24 自带的能力，
 * 因此这些测试跑的是与构建产物同一份源码，不是复制出来的第二套逻辑。
 */
const SRC = path.resolve(import.meta.dirname, "../src");
const SUFFIXES = [".ts", ".tsx", "/index.ts"];

function firstExisting(absolute) {
  for (const suffix of SUFFIXES) {
    const candidate = absolute + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return absolute;
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const hit = firstExisting(path.join(SRC, specifier.slice(2)));
    if (hit) return next(pathToFileURL(hit).href, context);
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const base = path.dirname(fileURLToPath(context.parentURL));
    const hit = firstExisting(path.resolve(base, specifier));
    if (hit) return next(pathToFileURL(hit).href, context);
  }
  return next(specifier, context);
}
