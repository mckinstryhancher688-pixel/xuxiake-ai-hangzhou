import { register } from "node:module";

/** 供 `node --import ./evidence/register-alias.mjs <测试文件>` 使用。 */
register("./alias-hook.mjs", import.meta.url);
