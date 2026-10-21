import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 这个模块会 spawn 子进程并读取 process.env，只允许出现在服务端代码里。
if (typeof window !== "undefined") {
  throw new Error("lib/server/flyai-cli 只能在 Next.js 服务端加载。");
}

const CLI_PACKAGE_DIR = path.join("@fly-ai", "flyai-cli");
const CLI_TIMEOUT_MS = 60_000;
const STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 16 * 1024;

let resolvedEntry: string | null | undefined;

export interface FlyAiRunOptions {
  cityName: string;
  category: string;
  apiKey: string;
}

export interface FlyAiRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** 已脱敏的命令行，可直接展示给用户 */
  command: string;
  cliEntry: string | null;
  /** 子进程层面的失败（找不到 CLI / 启动失败 / 超时 / 无输出）；业务错误由调用方解析 stdout 判断 */
  error: string | null;
}

/**
 * 飞猪 FlyAI 只发布为 npm CLI，没有浏览器可调的 HTTP 接口，
 * 所以服务端用 `node <全局包 bin>` 直接跑它的 bundle：
 * 不经过 shell，中文类别名不会被 cmd.exe 代码页破坏，参数也不可能被注入。
 */
export function resolveCliEntry(): string | null {
  if (resolvedEntry === undefined) resolvedEntry = findCliEntry();
  return resolvedEntry;
}

/**
 * 展示用的路径写法。/api/discover 是公网可读的，绝对路径会把本机用户名一起带出去，
 * 所以这里只保留 node_modules 之后那一段——足够定位问题，不含个人信息。
 */
export function describeCliEntry(entry: string | null): string | null {
  if (!entry) return null;
  const marker = `node_modules${path.sep}@fly-ai${path.sep}flyai-cli`;
  const index = entry.indexOf(marker);
  if (index !== -1) return entry.slice(index);
  const relative = path.relative(process.cwd(), entry);
  return relative && !relative.startsWith("..") ? relative : path.basename(entry);
}

function candidateGlobalRoots(): string[] {
  const roots = [
    // 项目自带的 node_modules 排第一：云端（Vercel / 容器）没有全局 npm 包，
    // 只有打进部署产物里的这一份，配合 next.config.ts 的 outputFileTracingIncludes 才拿得到。
    path.join(process.cwd(), "node_modules"),
    process.env.FLYAI_CLI_ROOT,
    process.env.npm_config_prefix
      ? path.join(process.env.npm_config_prefix, "node_modules")
      : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules") : null,
    process.env.HOME ? path.join(process.env.HOME, ".npm-global", "node_modules") : null,
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
  ];
  return roots.filter((root): root is string => Boolean(root));
}

function entryInRoot(root: string): string | null {
  const packageDir = path.join(root, CLI_PACKAGE_DIR);
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const relativeEntry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.flyai;
    if (!relativeEntry) return null;
    const entry = path.resolve(packageDir, relativeEntry);
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

function findCliEntry(): string | null {
  for (const root of candidateGlobalRoots()) {
    const entry = entryInRoot(root);
    if (entry) return entry;
  }
  // 兜底：问一次 npm 全局根目录。参数是写死的字面量、不含任何外部输入，
  // 这里必须用 shell:true 才能在 Windows 上跑通 npm.cmd。
  // 云端没有 npm 可执行文件时，spawnSync 只会返回错误、不会抛异常，直接走「找不到」分支。
  const probe = spawnSync("npm", ["root", "-g"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    shell: true,
  });
  const root = probe.stdout?.trim();
  return root ? entryInRoot(root) : null;
}

/**
 * 白名单式环境变量：只把运行 node 子进程必需的东西传下去，再显式注入这一个 key。
 * 之前是展开整个 process.env —— 云端那里面装着高德、百炼的全部凭据，
 * 等于把无关的密钥交给一个第三方混淆包；DEBUG_FLYAI_* 这类覆盖项也一并被挡在外面。
 */
function buildChildEnv(apiKey: string): NodeJS.ProcessEnv {
  const inherited = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "COMSPEC",
    "LANG",
    "TZ",
    "NODE_EXTRA_CA_CERTS",
  ];
  const env: Record<string, string> = {};
  for (const name of inherited) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.FLYAI_API_KEY = apiKey;
  // Next 的类型把 NODE_ENV 标成必填，但这里不该替子进程编一个值出来
  return env as NodeJS.ProcessEnv;
}

export function tail(text: string, limit = 300): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > limit ? `…${flattened.slice(-limit)}` : flattened;
}

export function runFlyAiPoiSearch({
  cityName,
  category,
  apiKey,
}: FlyAiRunOptions): Promise<FlyAiRunResult> {
  const cliEntry = resolveCliEntry();
  const args = ["search-poi", "--city-name", cityName, "--category", category];
  const command = `FLYAI_API_KEY=<已隐藏> node ${describeCliEntry(cliEntry) ?? "@fly-ai/flyai-cli"} ${args
    .map((arg) => `"${arg}"`)
    .join(" ")}`;

  if (!cliEntry) {
    return Promise.resolve({
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      command,
      cliEntry: null,
      error:
        "服务端找不到 @fly-ai/flyai-cli 的入口文件。本地请执行 npm install（它是项目依赖，全局安装也可以）；" +
        "部署环境要确认它被打进函数产物（next.config.ts 的 outputFileTracingIncludes），或设置 FLYAI_CLI_ROOT 指向可用的 node_modules。",
    });
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: os.tmpdir(),
      windowsHide: true,
      env: buildChildEnv(apiKey),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CLI_TIMEOUT_MS);

    const finish = (error: string | null, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr: stderr.slice(0, STDERR_LIMIT_BYTES),
        durationMs: Date.now() - startedAt,
        command,
        cliEntry: describeCliEntry(cliEntry),
        error,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < STDOUT_LIMIT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish(`无法启动 flyai CLI 子进程：${error.message}`, null);
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish(`flyai CLI 调用超过 ${CLI_TIMEOUT_MS / 1000} 秒，已终止子进程。`, code);
        return;
      }
      // Windows 上 CLI 打印完 JSON 后会因 libuv 断言以非 0 退出码结束，
      // 所以「有没有 stdout」才是判据，退出码只作为参考写进 proof。
      if (!stdout.trim()) {
        const detail = tail(stderr);
        finish(`flyai CLI 没有任何标准输出（exit=${code}）${detail ? `：${detail}` : ""}`, code);
        return;
      }
      finish(null, code);
    });
  });
}
