import { canExecuteSolo, solveSolo, SOLO_MIN_STOPS, type SoloConstraints } from "@/lib/negotiation/solo";
import { amapCounters } from "@/lib/server/amap";
import { getFactSet } from "@/lib/server/facts";
import { readBoundedJson, shortId } from "@/lib/server/plan-http";
import {
  DEFAULT_STAY_MINUTES,
  MAX_WALK_MINUTES,
  MIN_WALK_MINUTES,
  STAY_MINUTE_OPTIONS,
  isStayOption,
} from "@/lib/walk-minutes";
import { connection } from "next/server";

/**
 * 单人「事实层免费重解」。
 *
 * 核验（/api/verify）已经付费把全部有向路段测完并入事实层；这里只换一个求解目标，
 * 因此不发起任何高德请求。这个端点存在的意义就是：改「爸妈全程一共能走多久」不该再花钱。
 * 界面只传 maxWalkMinutes；maxWalkMeters / maxSegmentMeters 仍受支持（真实验收脚本与以后重新露出单段时使用）。
 *
 * 边界（与设计稿一致）：
 * - 只在已实测范围内重排/减站；必须去一个没测过的站会返回 needs-payment，不自动补测；
 * - 上限判定只在这里做，前端不得自行比较；
 * - factsId 过期不自动重跑核验（那会真实消耗数十次高德请求）。
 */

const MIN_WALK_METERS = 200;
const MAX_WALK_METERS = 40_000;

function parseWalkMinutes(value: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, error: "maxWalkMinutes 必须是整数分钟（或留空表示不设这个限制）。" };
  }
  if (value < MIN_WALK_MINUTES || value > MAX_WALK_MINUTES) {
    return { ok: false, error: `maxWalkMinutes 必须在 ${MIN_WALK_MINUTES}~${MAX_WALK_MINUTES} 之间。` };
  }
  return { ok: true, value };
}

function parseWalkLimit(value: unknown, label: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, error: `${label} 必须是整数米（或留空表示不设这个限制）。` };
  }
  if (value < MIN_WALK_METERS || value > MAX_WALK_METERS) {
    return { ok: false, error: `${label} 必须在 ${MIN_WALK_METERS}~${MAX_WALK_METERS} 之间。` };
  }
  return { ok: true, value };
}

function parseIdList(value: unknown, label: string): { ok: true; value: string[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: `${label} 必须是站点 id 数组。` };
  if (value.length > 12) return { ok: false, error: `${label} 最多 12 项。` };
  const ids: string[] = [];
  for (const item of value) {
    const id = shortId(item, label);
    if (typeof id === "string" && id && !/完整|缺失/.test(id)) {
      ids.push(id);
      continue;
    }
    return { ok: false, error: `${label} 里含有不合法的站点 id。` };
  }
  return { ok: true, value: ids };
}

export async function POST(request: Request) {
  await connection();
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const factsId = typeof body.factsId === "string" ? body.factsId.trim() : "";
  if (!factsId) return Response.json({ error: "需要 factsId（来自一次真实核验的报告）。" }, { status: 400 });

  const facts = getFactSet(factsId);
  if (!facts) {
    return Response.json(
      {
        error:
          "这份事实集在本实例上已经找不到（超过 6 小时或服务已重启）。重新核验会真实消耗数十次高德请求，" +
          "所以这里不自动重跑，请回主界面重新点一次「生成我的路线」。",
        code: "facts-unavailable",
      },
      { status: 410 },
    );
  }

  const limit = parseWalkLimit(body.maxWalkMeters, "maxWalkMeters");
  if (!limit.ok) return Response.json({ error: limit.error, code: "constraint-invalid" }, { status: 400 });
  const minutes = parseWalkMinutes(body.maxWalkMinutes);
  if (!minutes.ok) return Response.json({ error: minutes.error, code: "constraint-invalid" }, { status: 400 });
  // 每站停留：只接受菜单里的几个数（D2），不传或 null 沿用默认 30 分钟
  const stayRaw = body.stayMinutes;
  if (stayRaw !== undefined && stayRaw !== null && !isStayOption(stayRaw)) {
    return Response.json(
      { error: `stayMinutes 只能是 ${STAY_MINUTE_OPTIONS.join(" / ")} 之一（或留空，沿用默认 ${DEFAULT_STAY_MINUTES} 分钟）。`, code: "constraint-invalid" },
      { status: 400 },
    );
  }
  const stayMinutes = isStayOption(stayRaw) ? stayRaw : DEFAULT_STAY_MINUTES;
  const segment = parseWalkLimit(body.maxSegmentMeters, "maxSegmentMeters");
  if (!segment.ok) return Response.json({ error: segment.error, code: "constraint-invalid" }, { status: 400 });
  const mustVisit = parseIdList(body.mustVisit, "mustVisit");
  if (!mustVisit.ok) return Response.json({ error: mustVisit.error, code: "constraint-invalid" }, { status: 400 });
  const neverAccept = parseIdList(body.neverAccept, "neverAccept");
  if (!neverAccept.ok) return Response.json({ error: neverAccept.error, code: "constraint-invalid" }, { status: 400 });

  const constraints: SoloConstraints = {
    maxWalkMeters: limit.value,
    maxWalkMinutes: minutes.value,
    stayMinutes,
    maxSegmentMeters: segment.value,
    mustVisit: mustVisit.value,
    neverAccept: neverAccept.value,
  };

  // 证明「这次重解没有新增高德调用」：前后比对计数，写进响应而不是口头保证
  const before = amapCounters();
  const solve = solveSolo(facts, constraints);
  const after = amapCounters();
  const newCalls =
    after.placeCalls - before.placeCalls + (after.walkingCalls - before.walkingCalls);

  if (newCalls !== 0) {
    // 纯本地求解不该产生任何调用；一旦出现说明代码被改坏了，必须大声报错
    console.error(`[resolve] 事实层重解竟然新增了 ${newCalls} 次高德调用，这违反「0 新增」的承诺`);
  }

  if (!solve.ok) {
    return Response.json(
      {
        ok: false,
        code: solve.kind,
        reason: solve.reason,
        suggestion: solve.suggestion,
        missingEdges: solve.missingEdges,
        extraLegsNeeded: solve.extraLegsNeeded,
        minStops: SOLO_MIN_STOPS,
        cost: { newAmapCalls: newCalls },
      },
      { status: solve.kind === "constraint-invalid" ? 400 : 200 },
    );
  }

  const execution = canExecuteSolo(solve.solve.best, constraints);

  return Response.json({
    ok: true,
    itinerary: solve.solve.best,
    constraints,
    explanation: solve.explanation,
    execution,
    cost: { newAmapCalls: newCalls },
    facts: {
      factsId: facts.factsId,
      cityName: facts.cityName,
      poolSize: facts.pool.length,
      measuredLegs: Object.keys(facts.legs).length,
      measuredAt: facts.measuredAt,
    },
    note: solve.solve.note,
  });
}

/** 这个端点只接受 POST；GET 上来通常是想直接看结果，明确拒绝。 */
export async function GET() {
  return Response.json({ error: "本端点只接受 POST（需要 factsId 与条件）。" }, { status: 405 });
}
