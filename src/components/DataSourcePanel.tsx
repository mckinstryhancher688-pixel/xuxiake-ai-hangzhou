import type { AdapterNote } from "@/hooks/useJourney";

export function DataSourcePanel({ adapterNotes }: { adapterNotes: AdapterNote[] }) {
  return (
    <section className="rounded-2xl border border-line bg-paper p-3">
      <h2 className="text-[11px] font-medium tracking-wide text-ink-300">
        数据源状态 · 未点「开始核验」时页面是阶段一演示数据；核验之后行程点位与步行折线来自飞猪检索 + 高德实测，
        只有「阶段一预写讲解」仍是 Mock，真实讲解在上方百炼面板
      </h2>

      <ul className="mt-2 space-y-2">
        {adapterNotes.map((adapter) => {
          const live = adapter.source === "live";
          return (
            <li key={adapter.name} className="text-[11px] leading-relaxed">
              <span className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 font-medium ${
                    live ? "bg-brand-600/15 text-brand-700" : "bg-accent-500/15 text-accent-600"
                  }`}
                >
                  {live ? "已接入" : "MOCK"}
                </span>
                <span className="font-medium text-ink-700">{adapter.name}</span>
              </span>
              <span className="mt-0.5 block text-ink-300">{adapter.note}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
