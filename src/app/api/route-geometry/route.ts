import { fetchRouteGeometry } from "@/lib/server/route-geometry";
import { geometryFailure, readOfficialRouteGeometry } from "@/lib/server/official-route-geometry";
import { readBoundedJson } from "@/lib/server/plan-http";

/**
 * 联合模式只读当前正式版本保存的道路几何，缺失也不自动补测。
 * 单人模式沿用按需补查；任何联合模式字段都不能落回单人分支。
 */
export async function POST(request: Request) {
  try {
    const parsed = await readBoundedJson(request);
    if (!parsed.ok) {
      const payload = await parsed.response.json() as { error: string };
      const failure = geometryFailure(payload.error, parsed.response.status);
      return Response.json(failure.result, { status: failure.status });
    }
    const { body } = parsed;
    if (Object.hasOwn(body, "planId") || Object.hasOwn(body, "officialRevision")) {
      const outcome = readOfficialRouteGeometry(request, body);
      return Response.json(outcome.result, { status: outcome.status });
    }
    const result = await fetchRouteGeometry(body);
    return Response.json(result, { status: result.error ? 400 : 200 });
  } catch {
    const failure = geometryFailure("路线几何请求未能完成，请刷新后重试。", 500);
    return Response.json(
      failure.result,
      { status: failure.status },
    );
  }
}
