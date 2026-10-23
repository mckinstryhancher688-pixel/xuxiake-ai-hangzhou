import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 最小快照的持久化验收：零高德、零飞猪、零百炼。
 *
 * 用「另起一个进程」来真实模拟重启——同一进程里改内存再读内存证明不了任何事。
 * 每个子进程都把 globalThis.fetch 换成会抛错的桩：只要有任何一步偷偷去调外部服务，
 * 当场就是硬失败，不会静默花钱。
 *
 * 跑法：`node evidence/plan-persistence.mjs`
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// 子进程必须与父进程用同一个临时目录，否则「重启后读回来」读的是另一个文件夹
const TMP = process.env.XUXIAKE_TEST_TMP ?? fs.mkdtempSync(path.join(os.tmpdir(), "xuxiake-snapshot-"));
const SNAPSHOT = path.join(TMP, "plan-snapshot.json");
const HANDOFF = path.join(TMP, "handoff.json");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

const PHASE = process.argv.find((arg) => arg.startsWith("--phase="))?.slice(8);

if (PHASE) {
  await runPhase(PHASE);
} else {
  await orchestrate();
}

/* ── 子进程入口 ─────────────────────────────────────────────────── */

async function runPhase(phase) {
  const outbound = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    outbound.push(String(input));
    throw new Error(`持久化测试不允许任何外部调用：${String(input).slice(0, 80)}`);
  };
  process.env.PLAN_SNAPSHOT_FILE = SNAPSHOT;

  const say = (name, pass, detail) => {
    console.log(JSON.stringify({ check: name, pass, detail }));
  };

  const facts = await import("../src/lib/server/facts.ts");
  const store = await import("../src/lib/server/plan-store.ts");
  const snapshot = await import("../src/lib/server/plan-snapshot.ts");
  const { makeCompleteFacts } = await import("./negotiation-fixture.ts");
  const { emptyConditions } = await import("../src/lib/negotiation/types.ts");

  if (phase === "write") {
    const live = makeCompleteFacts();
    live.measuredAt = new Date().toISOString();
    facts.putFactSet(live);
    const created = store.createPlanRecord({
      facts: live,
      conditionsA: emptyConditions("A"),
      now: new Date(),
    });
    const planId = created.planId;
    const cap = 6000;
    await store.runPlanMutation(planId, {
      kind: "conditions", role: "A", conditions: emptyConditions("A"),
      expectedRevision: null, attemptId: "w-a", confirmCost: false,
    });
    const bConditions = { ...emptyConditions("B"), hard: { ...emptyConditions("B").hard, maxWalkMeters: cap } };
    await store.runPlanMutation(planId, {
      kind: "conditions", role: "B", conditions: bConditions,
      expectedRevision: 1, attemptId: "w-b", confirmCost: false,
    });
    const head = store.planSnapshot(planId, "A");
    await store.runPlanMutation(planId, { kind: "confirm", role: "B", revision: head.headRevision, contentHash: head.head.contentHash });
    const confirmed = await store.runPlanMutation(planId, {
      kind: "confirm", role: "A", revision: head.headRevision, contentHash: head.head.contentHash,
    });
    fs.writeFileSync(HANDOFF, JSON.stringify({
      planId,
      tokens: created.tokens,
      headRevision: head.headRevision,
      contentHash: head.head.contentHash,
      walkMeters: head.head.itinerary.totalWalkMeters,
      cap,
      confirmedCode: confirmed.code,
    }), "utf8");
    say("写入阶段：双方确认同一版本", confirmed.code === "ok", { code: confirmed.code });
  }

  if (phase === "read") {
    const handoff = JSON.parse(fs.readFileSync(HANDOFF, "utf8"));
    const asA = store.identifyRole(handoff.planId, handoff.tokens.A);
    const asB = store.identifyRole(handoff.planId, handoff.tokens.B);
    const wrong = store.identifyRole(handoff.planId, "0".repeat(32));
    say("重启后 A 的链接仍然认得（服务端只存哈希）", asA.role === "A", asA);
    say("重启后 B 的链接仍然认得", asB.role === "B", asB);
    say("错令牌仍然不认", "error" in wrong && wrong.error === "bad-token", wrong);
    const snap = store.planSnapshot(handoff.planId, "A");
    say("恢复出的版本号与确认状态一致",
      snap?.officialRevision === handoff.headRevision && snap?.headRevision === handoff.headRevision,
      { official: snap?.officialRevision, head: snap?.headRevision, want: handoff.headRevision });
    say("恢复出的正式版本仍是双方确认",
      snap?.canExecute.allowed === true && snap?.head?.confirmations?.A && snap?.head?.confirmations?.B,
      { reason: snap?.canExecute.reason });
    say("恢复出的步行数字与写入时同源", snap?.head?.itinerary.totalWalkMeters === handoff.walkMeters, {
      restored: snap?.head?.itinerary.totalWalkMeters, written: handoff.walkMeters,
    });
    const journey = store.planExecutionJourney(handoff.planId);
    say("重启后双人执行入口读到的就是那一版", journey?.itinerary.totalWalkMeters === handoff.walkMeters, {
      revision: journey?.officialRevision,
    });
    const status = store.planPersistenceStatus();
    say("快照状态如实报告恢复了多少条", status.restored?.status === "loaded" && status.restored.loaded === 1, status.restored);
    say("快照文件落在被忽略的目录里", status.file.includes(".json") && !path.isAbsolute(status.file), { file: status.file });
    const raw = fs.readFileSync(SNAPSHOT, "utf8");
    say("快照里没有角色令牌明文", !raw.includes(handoff.tokens.A) && !raw.includes(handoff.tokens.B));
    // 只查真正的密钥形状：amapId 这类字段名是高德 POI 标识，本来就该在事实层里
    const secretShape = raw.match(/AMAP_[A-Z_]*KEY|BAILIAN[A-Z_]*KEY|sk-[A-Za-z0-9]{8,}|Bearer\s|jscode|security_?[Cc]ode/gi) ?? [];
    say("快照里没有密钥形状的内容", secretShape.length === 0, { 命中: secretShape.slice(0, 3) });
  }

  if (phase === "stale-write") {
    const handoff = JSON.parse(fs.readFileSync(HANDOFF, "utf8"));
    const loaded = snapshot.loadSnapshot();
    const plan = loaded.plans.find((item) => item.planId === handoff.planId);
    // 把采集时间往前推 7 小时：事实层的 6 小时有效期应当当场过期
    plan.facts.measuredAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const saved = await snapshot.persistSnapshot([plan]);
    say("过期场景的快照写入成功", saved.ok, saved.error);
  }

  if (phase === "poll-expiry") {
    const handoff = JSON.parse(fs.readFileSync(HANDOFF, "utf8"));
    const originalNow = Date.now;
    const originalMeasuredAt = snapshot.loadSnapshot().plans.find((item) => item.planId === handoff.planId).facts.measuredAt;
    let clock = Date.parse(originalMeasuredAt);
    Date.now = () => clock;
    try {
      const initial = store.planSnapshot(handoff.planId, "B");
      clock += 5 * 60 * 60 * 1000 + 59 * 60 * 1000;
      const stillLive = store.planSnapshot(handoff.planId, "B");
      say("持续读取到原采集时间5小时59分时，正式版本仍可用", initial?.canExecute.allowed && stillLive?.canExecute.allowed);
      // 上一次 GET 刚刚触碰过内存 TTL。再过两分钟，必须按原采集时间关门，不能续到下一轮6小时。
      clock += 2 * 60 * 1000;
      const expired = store.planSnapshot(handoff.planId, "B");
      say("轮询不续期：原事实超过6小时后，角色页快照门禁关闭", expired?.canExecute.allowed === false, expired?.canExecute);
      say("快照明确说明事实过期且需要重新核验", /事实.*过期/.test(expired?.canExecute.reason ?? "") && /重新核验/.test(expired?.canExecute.reason ?? ""));
      say("过期快照与执行入口判定一致", store.planExecutionJourney(handoff.planId) === null && store.factsStillLive(handoff.planId) === false);
      say("过期不伪造新版本或删掉历史确认", expired?.headRevision === handoff.headRevision && expired?.officialRevision === handoff.headRevision && Boolean(expired?.official?.confirmations.A && expired?.official?.confirmations.B));
      say("轮询不改写原始事实采集时间", expired?.facts.measuredAt === originalMeasuredAt);
    } finally {
      Date.now = originalNow;
    }
  }

  if (phase === "stale-read") {
    const handoff = JSON.parse(fs.readFileSync(HANDOFF, "utf8"));
    const live = store.factsStillLive(handoff.planId);
    const journey = store.planExecutionJourney(handoff.planId);
    const reason = store.executionBlockReason(handoff.planId);
    say("事实过期后不再当作可用", live === false, { live });
    say("事实过期时执行入口直接关闭，不静默重跑核验", journey === null, { reason });
    say("给出的原因是可读的失效说明", /过期|失效/.test(reason), { reason });
    const expiredSnapshot = store.planSnapshot(handoff.planId, "A");
    say("恢复过期事实后角色页也不会宣称正式可执行", expiredSnapshot?.canExecute.allowed === false && /过期/.test(expiredSnapshot?.canExecute.reason ?? ""), expiredSnapshot?.canExecute);
    say("恢复过期事实不会改动已确认版本号", expiredSnapshot?.headRevision === handoff.headRevision && expiredSnapshot?.officialRevision === handoff.headRevision);
  }

  if (phase === "corrupt") {
    const raw = fs.readFileSync(SNAPSHOT, "utf8");
    const broken = raw.replace(/"planId":\s*"/, '"planId": "x');
    fs.copyFileSync(SNAPSHOT, `${SNAPSHOT}.bak`);
    fs.writeFileSync(SNAPSHOT, broken, "utf8");
    say("已构造一个被改坏的快照", broken !== raw);
  }

  if (phase === "corrupt-read") {
    const handoff = JSON.parse(fs.readFileSync(HANDOFF, "utf8"));
    const identified = store.identifyRole(handoff.planId, handoff.tokens.A);
    const status = store.planPersistenceStatus();
    say("校验不过时整份拒绝恢复", "error" in identified && identified.error === "unknown-plan", identified);
    say("拒绝恢复的原因如实可查", status.restored?.status === "corrupt", status.restored);
  }

  say(`本阶段没有发出任何外部请求（${phase}）`, outbound.length === 0, { outbound: outbound.slice(0, 3) });
  globalThis.fetch = realFetch;
}

/* ── 主进程：按顺序起子进程并汇总 ───────────────────────────────── */

async function orchestrate() {
  const phases = ["write", "read", "poll-expiry", "stale-write", "stale-read", "corrupt", "corrupt-read"];
  for (const phase of phases) {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(HERE, "register-alias.mjs")).href,
        path.join(HERE, "plan-persistence.mjs"),
        `--phase=${phase}`,
      ],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env, PLAN_SNAPSHOT_FILE: SNAPSHOT, XUXIAKE_TEST_TMP: TMP } },
    );
    const lines = (child.stdout ?? "").split("\n").filter(Boolean);
    let sawCheck = false;
    for (const line of lines) {
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        console.log(`  [${phase}] ${line}`);
      }
      if (!parsed?.check) continue;
      sawCheck = true;
      check(`[${phase}] ${parsed.check}`, Boolean(parsed.pass), parsed.detail);
    }
    if (child.status !== 0) {
      check(`[${phase}] 子进程正常退出`, false, { status: child.status, stderr: (child.stderr ?? "").slice(0, 400) });
    } else if (!sawCheck) {
      check(`[${phase}] 子进程有产出断言`, false, { stdout: (child.stdout ?? "").slice(0, 200) });
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  const passed = results.filter((item) => item.pass).length;
  console.log(`\n${passed}/${results.length} 通过（夹具数据 + 真实文件读写，零高德/飞猪/百炼调用）`);
  process.exit(passed === results.length ? 0 : 1);
}
