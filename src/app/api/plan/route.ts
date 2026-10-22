import { getFactSet, factsStoreStatus } from "@/lib/server/facts";
import { amapCounters } from "@/lib/server/amap";
import { buildSnapshot, readBoundedJson, requestOrigin, shortId, viewOf } from "@/lib/server/plan-http";
import { createPlanRecord, runPlanMutation, withPlanLock, planStoreStatus, planPersistenceStatus } from "@/lib/server/plan-store";
import { sanitizeConditions, buildPlanLink } from "@/lib/plan-api";
import { connection } from "next/server";

/**
 * 协商方案的账本状态。cacheComponents 下 GET 会被预渲染，
 * 必须 await connection() 才能按请求实时读到本实例的真实计数。
 */
export async function GET() {
  await connection();
  const counters = amapCounters();
  return Response.json({
    plans: planStoreStatus(),
    facts: factsStoreStatus(),
    persist: planPersistenceStatus(),
    walkingHourlyUsed: counters.walkingCalls,
    walkingHourlyCap: counters.walkingHourlyCap,
    placeHourlyUsed: counters.placeCalls,
    placeHourlyCap: counters.placeHourlyCap,
    cacheEntries: counters.cacheEntries,
    pid: process.pid,
    serverTime: new Date().toISOString(),
  });
}

/**
 * 发起一次双人协商：基于某份已核验事实集建 plan，并发两条角色链接。
 * 这一步本身不调用高德——事实层已经为这次核验付过费了。
 */
export async function POST(request: Request) {
  const parsed = await readBoundedJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const factsId = shortId(body.factsId, "factsId");
  if (!factsId) {
    return Response.json({ error: "需要 factsId（来自一次真实核验的报告）。" }, { status: 400 });
  }
  const facts = getFactSet(factsId);
  if (!facts) {
    return Response.json(
      {
        error:
          "这份事实集在本实例上已经找不到（超过 6 小时或服务已重启）。重新核验会真实消耗约 36 次高德请求，" +
          "所以这里不自动重跑，请回到主界面重新点一次「生成我的路线」。",
        code: "facts-unavailable",
      },
      { status: 410 },
    );
  }

  const sanitized = sanitizeConditions(body.conditions ?? {}, "A");
  if (!sanitized.ok) {
    return Response.json({ error: sanitized.error, code: "constraint-invalid" }, { status: 400 });
  }

  const created = createPlanRecord({ facts, conditionsA: sanitized.conditions, now: new Date() });
  const attemptId = shortId(body.attemptId, "attemptId") ?? `create:${created.planId}`;

  const first = await withPlanLock(created.planId, () =>
    runPlanMutation(created.planId, {
      kind: "conditions",
      role: "A",
      conditions: sanitized.conditions,
      expectedRevision: null,
      attemptId,
      confirmCost: body.confirmCost === true,
    }),
  );

  const origin = requestOrigin(request);
  return Response.json({
    planId: created.planId,
    // 角色链接是访问凭据：只在这一次响应里出现，服务端只存哈希
    links: {
      A: buildPlanLink(origin, created.planId, "A", created.tokens.A),
      B: buildPlanLink(origin, created.planId, "B", created.tokens.B),
    },
    first: viewOf(first),
    snapshot: buildSnapshot(created.planId, "A"),
  });
}

/** 令牌永远不回显在响应里；这条只是给误用 PUT 的人一个明确说法。 */
export async function PUT() {
  return Response.json({ error: "本端点不支持 PUT。" }, { status: 405 });
}
