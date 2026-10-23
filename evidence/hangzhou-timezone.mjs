import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { assumedTripWindow, isWindowClosed } from "../src/lib/verification.ts";
import { formatHangzhouDateTime } from "../src/lib/hangzhou-time.ts";
import { solveJoint } from "../src/lib/negotiation/solve.ts";
import { emptyConditions } from "../src/lib/negotiation/types.ts";
import { makeCompleteFacts } from "./negotiation-fixture.ts";

/** 只运行纯函数与夹具；不导入 provider、环境文件或调用任何网络。 */
const cases = [
  { instant: "2026-10-22T00:30:00.000Z", day: "2026-10-22" },
  { instant: "2026-10-22T15:59:59.999Z", day: "2026-10-22" },
  { instant: "2026-10-22T16:00:00.000Z", day: "2026-10-23" },
  { instant: "2026-12-31T16:00:00.000Z", day: "2027-01-01" },
  { instant: "2026-07-01T16:01:00.000Z", day: "2026-07-02" },
];

function probe() {
  return cases.map(({ instant, day }) => {
    const window = assumedTripWindow(new Date(instant));
    const expectedStart = `${day}T05:00:00.000Z`; // 上海 13:00
    const end = new Date(window.startAt.getTime() + 240 * 60_000);
    assert.equal(window.startAt.toISOString(), expectedStart);
    assert.equal(end.toISOString(), `${day}T09:00:00.000Z`); // 上海 17:00
    assert.equal(window.startMinutes, 13 * 60);
    assert.equal(window.endMinutes, 17 * 60);
    assert.match(formatHangzhouDateTime(window.startAt), /13:00:00.*Asia\/Shanghai/);
    assert.match(formatHangzhouDateTime(end), /17:00:00.*Asia\/Shanghai/);
    assert.equal(isWindowClosed([[13 * 60, 17 * 60]], window.startMinutes, window.endMinutes), false);
    assert.equal(isWindowClosed([[17 * 60, 18 * 60]], window.startMinutes, window.endMinutes), true);

    // 唯一可选的一站恰好用满四小时：190 步行 + 30 停留 + 20 缓冲。
    // 即使请求发生在当天深夜，17:00 上限也应放行，16:59 必须拒绝。
    const facts = makeCompleteFacts();
    facts.pool = facts.pool.filter((stop) => stop.id === "c1");
    facts.legs = { "__start__->c1": facts.legs["__start__->c1"] };
    Object.assign(facts.legs["__start__->c1"].leg, { durationMinutes: 190, durationSeconds: 190 * 60 });
    const a = emptyConditions("A");
    a.hard.latestEndMinutes = 17 * 60;
    const onTime = solveJoint(facts, a, null, new Date(instant));
    assert.equal(onTime.kind, "found");
    assert.equal(onTime.best.assumedStartAt, expectedStart);
    assert.equal(onTime.best.totalMinutes, 240);
    assert.equal(onTime.best.budgetMinutes, 240);
    assert.ok(onTime.satisfied.some((hit) => hit.text.includes("预计 17:00 结束")));
    a.hard.latestEndMinutes -= 1;
    const tooLate = solveJoint(facts, a, null, new Date(instant));
    assert.equal(tooLate.kind, "hard-conflict");
    assert.equal(tooLate.best, null);
    return {
      instant, start: window.startAt.toISOString(), end: end.toISOString(),
      startText: formatHangzhouDateTime(window.startAt), endText: formatHangzhouDateTime(end),
      itineraryStart: onTime.best.assumedStartAt, acceptedEnd: "17:00", rejectedEnd: "16:59",
    };
  });
}

if (process.argv.includes("--child")) {
  process.stdout.write(JSON.stringify(probe()));
} else {
  let reference;
  for (const timezone of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
    const child = spawnSync(process.execPath, [import.meta.filename, "--child"], {
      env: { ...process.env, TZ: timezone }, encoding: "utf8",
    });
    assert.equal(child.status, 0, `${timezone}: ${child.stderr}`);
    const actual = JSON.parse(child.stdout);
    if (reference) assert.deepEqual(actual, reference, `${timezone} must produce identical Shanghai results`);
    else reference = actual;
    console.log(`PASS TZ=${timezone}：${cases.length} 个相同 instant，上海日界线/13:00出发/17:00边界/UI标注一致`);
  }
  console.log(`3/3 时区通过，${cases.length * 3} 个日期与行程边界场景（纯函数夹具，零真实调用）`);
}
