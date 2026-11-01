import { stopIdOf } from "@/lib/types";
import { formatMinutes } from "@/lib/format";
import type { RevisionView } from "@/lib/plan-api";

/** 纯展示服务端正式版本：不加载地图，不发现地点，不请求路线或讲解。 */
export function OfficialPlanCard({ revision, headRevision }: { revision: RevisionView; headRevision: number | null }) {
  const itinerary = revision.itinerary;
  return (
    <section aria-labelledby="official-plan-title" className="rounded-xl border border-emerald-300 bg-card p-4">
      <h2 id="official-plan-title" className="text-sm font-semibold">双方确认的正式行程 · v{revision.revision}</h2>
      <p className="mt-1 text-xs leading-5 text-ink-500">以下是双方确认的同一份行程，按起点和景点顺序查看即可。</p>
      {headRevision !== null && headRevision !== revision.revision ? (
        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
          另有待确认的 v{headRevision}，当前正式执行的仍是 v{revision.revision}。
        </p>
      ) : null}
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-paper p-2"><dt className="text-ink-500">步行（高德数据）</dt><dd className="mt-1 font-medium">{itinerary.totalWalkMeters} 米 · {itinerary.totalWalkMinutes} 分钟</dd></div>
        <div className="rounded-lg bg-paper p-2"><dt className="text-ink-500">行程合计</dt><dd className="mt-1 font-medium">{itinerary.stops.length} 站 · {formatMinutes(itinerary.totalMinutes)}</dd></div>
        <div className="rounded-lg bg-paper p-2"><dt className="text-ink-500">停留合计（模拟）</dt><dd className="mt-1">{itinerary.totalStayMinutes} 分钟</dd></div>
        <div className="rounded-lg bg-paper p-2"><dt className="text-ink-500">缓冲（产品设定）</dt><dd className="mt-1">{itinerary.bufferMinutes} 分钟</dd></div>
      </dl>

      <div className="mt-3 rounded-lg border border-line bg-paper p-3 text-xs">
        <p className="text-ink-500">出发起点</p>
        <p className="mt-1 font-medium">{itinerary.start.name}</p>
        {itinerary.start.address ? <p className="mt-1 text-ink-500">{itinerary.start.address}</p> : null}
      </div>
      <ol aria-label="正式行程的景点顺序" className="mt-2 space-y-2">
        {itinerary.stops.map((stop, index) => {
          const leg = itinerary.legs[index];
          return (
            <li key={`${index}-${stopIdOf(stop)}`} className="rounded-lg border border-line p-3 text-xs">
              {leg ? (
                <p className="leading-5 text-ink-500">步行：{leg.fromName} → {leg.toName} · {leg.distanceMeters} 米 / {leg.durationMinutes} 分钟（高德实测）</p>
              ) : <p className="text-amber-800">这一段的实测数据暂不可读，请刷新协商状态。</p>}
              <p className="mt-2 font-medium">第 {index + 1} 站 · {stop.name}</p>
              {stop.address ? <p className="mt-1 text-ink-500">{stop.address}</p> : null}
              <p className="mt-1 text-ink-500">建议停留 {stop.stayMinutes} 分钟（模拟值）</p>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-[11px] leading-5 text-ink-500">
        步行只统计起点到最后一站的已核验路段，不含回程和景区内部步行；停留与缓冲均非实测。全程时间预算为 {itinerary.budgetMinutes} 分钟。
      </p>
      {/* 整页载入会重新从当前 session 恢复 B 身份，避免 Activity 复用主界面旧的 A/退出状态。 */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- 此入口必须整页载入，不能复用主界面的旧角色状态。 */}
      <a href="/" className="mt-3 inline-block rounded-lg bg-brand-700 px-3 py-2 text-xs font-medium text-white">
        在主界面查看正式路线与地图
      </a>
      <p className="mt-2 text-[11px] leading-5 text-ink-500">此页展示行程清单。入口在当前标签页打开主界面，保留你的协商身份，并使用已确认版本；无需重新生成路线。</p>
    </section>
  );
}
