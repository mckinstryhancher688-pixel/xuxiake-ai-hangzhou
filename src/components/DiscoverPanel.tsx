import { MISSING_FIELD_LABELS, sameCategories } from "@/lib/discovery";
import { formatHangzhouShort } from "@/lib/hangzhou-time";
import type { Discover } from "@/hooks/useDiscover";
import type {
  DiscoverCategoryResult,
  DiscoverOrigin,
  DiscoveredPoi,
} from "@/lib/types";

const PHASE_BADGE = {
  idle: { label: "未调用", className: "bg-paper text-ink-300 ring-1 ring-line" },
  loading: { label: "调用中…", className: "bg-accent-500/15 text-accent-600" },
  live: { label: "LIVE · 飞猪真实返回", className: "bg-brand-600/15 text-brand-700" },
  failed: { label: "调用失败", className: "bg-red-500/10 text-red-600" },
  mock: { label: "MOCK · 演示数据", className: "bg-accent-500/15 text-accent-600" },
} as const;

/** 一屏里最多摊开几张候选卡片，剩下的收起来，免得把主流程挤出首屏。 */
const VISIBLE_CARDS = 4;

const ORIGIN_NOTICE: Record<DiscoverOrigin, string> = {  "flyai-live":
    "下列坐标是飞猪原始返回，本面板不做任何地理核实，因此不会画到地图上；坐标是否可信、能不能走进四小时路线，看「高德核验路线」面板。",
  "mock-fallback":
    "当前展示的是本地演示数据（Mock），不是飞猪返回；演示数据不区分类别，仅用于接口失败时对照。同样不会画到地图上。",
};

/**
 * 只展示飞猪返回的候选本身。
 * 技术日志（调用凭证、服务端状态、原始 JSON）统一收进 DebugPanel，避免挤占用户界面。
 */
export function DiscoverPanel({
  cityName,
  discover,
}: {
  cityName: string;
  discover: Discover;
}) {
  const batchCategories = discover.batch?.results.map((result) => result.category) ?? [];
  const stale = discover.batch !== null && !sameCategories(batchCategories, discover.selected);
  const badge = stale && discover.phase !== "loading"
    ? { label: "上次发现结果", className: "bg-accent-500/15 text-accent-600" }
    : PHASE_BADGE[discover.phase];
  const loading = discover.phase === "loading";
  const atCategoryLimit = discover.selected.length >= discover.maxCategories;
  const ttlMinutes = discover.status ? discover.status.cacheTtlSeconds / 60 : 10;

  return (
    <section className="rounded-2xl border border-line bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">重新发现 · 飞猪真实 POI</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            为下一次生成选择 {cityName} 的飞猪候选类别。默认从文创街区开始；自然风光可能包含远郊地点，
            不一定能组成四小时步行路线。卡片坐标仍须高德核实。
          </p>
        </div>
        <span
          className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {discover.categories.map((category) => {
          const active = discover.selected.includes(category);
          return (
            <button
              key={category}
              type="button"
              onClick={() => discover.toggleCategory(category)}
              disabled={loading || (!active && atCategoryLimit)}
              aria-pressed={active}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium ring-1 transition disabled:cursor-not-allowed disabled:opacity-40 ${
                active
                  ? "bg-brand-700 text-white ring-brand-700"
                  : "bg-paper text-ink-500 ring-line hover:bg-white"
              }`}
            >
              {category}
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => {
            void discover.rediscover();
          }}
          disabled={loading}
          className="ml-auto rounded-lg bg-accent-500 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "发现中…" : "重新发现"}
        </button>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-ink-300">
        单次最多 {discover.maxCategories} 个类别，未命中缓存时每类需要一次真实调用。
        选完类别就直接点「生成我的路线」（按钮一直钉在屏幕上）；路线里放哪几站由高德按「四小时走得完」挑，
        这里不提供手工加站，想换范围就改类别再核一次。
      </p>

      <details className="mt-2 rounded-lg bg-paper ring-1 ring-line">
        <summary className="cursor-pointer px-2.5 py-2 text-[11px] font-medium text-ink-700">
          调用与缓存说明
        </summary>
        <p className="px-2.5 pb-2.5 text-[10px] leading-relaxed text-ink-500">
          按钮由服务端代理调用 flyai search-poi CLI，{ttlMinutes} 分钟内同一（城市, 类别）复用服务端缓存，
          不产生新调用；每次调用的命令行、耗时与原始返回都在「开发调试」面板里。
        </p>
      </details>

      {discover.error && (
        <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
          <p className="text-[11px] font-semibold text-red-600">
            调用失败 · 以下是服务端返回的真实错误，没有做任何掩饰
          </p>
          <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-ink-700">
            {discover.error}
          </p>
          <button
            type="button"
            onClick={discover.fallbackToMock}
            className="mt-2 rounded-lg border border-line bg-card px-2.5 py-1.5 text-[11px] font-medium text-ink-700 transition hover:bg-paper"
          >
            改用演示数据（会明确标记为 Mock）
          </button>
        </div>
      )}

      {discover.batch && (
        <p className="mt-3 rounded-lg bg-paper px-2.5 py-2 text-[10px] leading-relaxed text-ink-500 ring-1 ring-line">
          {stale && <span className="mb-1 block font-medium text-accent-600">以下来自「{batchCategories.join(" + ")}」；已改选「{discover.selected.join(" + ")}」，当前类别尚未查询。</span>}
          {ORIGIN_NOTICE[discover.batch.origin]}
        </p>
      )}

      {discover.phase === "idle" && (
        <p className="mt-3 rounded-lg bg-paper px-2.5 py-2 text-[11px] leading-relaxed text-ink-300 ring-1 ring-line">
          尚未单独发现候选。可以直接点「生成我的路线」完成发现与核验；
          想先看飞猪原始返回，再点「重新发现」。切换类别本身不会发起查询。
        </p>
      )}

      {discover.batch?.results.map((result) => (
        <CategoryResult key={result.category} result={result} />
      ))}
    </section>
  );
}

function CategoryResult({ result }: { result: DiscoverCategoryResult }) {
  const visible = result.items.slice(0, VISIBLE_CARDS);
  const rest = result.items.slice(VISIBLE_CARDS);
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold text-ink-700">{result.category}</h3>
        <span className="text-[10px] text-ink-300">{result.items.length} 个候选</span>
      </div>
      {result.proof && !result.error && (
        <p className="mt-0.5 text-[10px] text-ink-300">
          来源 FlyAI · 查询于 {formatHangzhouShort(result.proof.invokedAt)}
          {result.proof.cacheHit ? "（复用缓存，仍为原采集时间）" : ""}
        </p>
      )}

      {result.error && (
        <p className="mt-1.5 break-words rounded-lg border border-red-500/30 bg-red-500/5 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-red-600">
          {result.error}
        </p>
      )}

      {visible.length > 0 && (
        <ul className="mt-2 space-y-2">
          {visible.map((poi, index) => (
            <PoiCard key={poi.id} poi={poi} index={index} />
          ))}
        </ul>
      )}

      {/* 一屏十张卡片会把真实主流程顶到屏幕外，所以其余候选默认收起 */}
      {rest.length > 0 && (
        <details className="mt-2 rounded-lg bg-paper ring-1 ring-line">
          <summary className="cursor-pointer px-2.5 py-2 text-[11px] font-medium text-ink-700">
            展开其余 {rest.length} 个候选
          </summary>
          <ul className="mt-1 space-y-2 px-2.5 pb-2.5">
            {rest.map((poi, index) => (
              <PoiCard key={poi.id} poi={poi} index={VISIBLE_CARDS + index} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function PoiCard({ poi, index }: { poi: DiscoveredPoi; index: number }) {
  return (
    <li className="rounded-xl border border-line bg-paper p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="truncate text-[13px] font-semibold text-ink-900">
            <span className="mr-1.5 font-mono text-[10px] font-normal text-ink-300">
              {index + 1}
            </span>
            {poi.name}
          </h4>
          <p className="mt-0.5 text-[10px] text-ink-500">
            {poi.category ?? "分类缺失"} ·{" "}
            {poi.source === "live" ? "来自飞猪" : "本地演示数据"}
          </p>
        </div>
        <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] text-ink-500 ring-1 ring-line">
          {poi.position ? "坐标待高德核验" : "无坐标"}
        </span>
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-700">
        {poi.address ?? "地址缺失"}
      </p>
      {poi.position && (
        <p className="mt-1 font-mono text-[10px] text-ink-500">
          {poi.position.lat.toFixed(6)}, {poi.position.lng.toFixed(6)}
        </p>
      )}
      {poi.description && (
        <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-ink-500">
          {poi.description}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {poi.missingFields.length === 0 ? (
          <span className="text-[10px] text-ink-300">字段完整</span>
        ) : (
          poi.missingFields.map((field) => (
            <span
              key={field}
              className="rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] text-accent-600"
            >
              缺 {MISSING_FIELD_LABELS[field]}
            </span>
          ))
        )}
        {poi.jumpUrl && (
          <a
            href={poi.jumpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto shrink-0 text-[11px] font-medium text-brand-700 underline underline-offset-2"
          >
            在飞猪查看 →
          </a>
        )}
      </div>
    </li>
  );
}
