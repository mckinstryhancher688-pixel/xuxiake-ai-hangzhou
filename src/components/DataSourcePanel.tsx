import type { AdapterNote } from "@/hooks/useJourney";

export function DataSourcePanel({ adapterNotes }: { adapterNotes: AdapterNote[] }) {
  return (
    <details className="rounded-2xl border border-line bg-paper p-3">
      <summary className="cursor-pointer text-[11px] font-medium tracking-wide text-ink-500">
        数据来源：飞猪 POI 检索 · 高德实测 · 百炼智能体（点开看每一项的真实状态）
      </summary>
      <p className="mt-2 text-[10px] leading-relaxed text-ink-300">
        没点「生成我的路线」之前，屏幕上的四站行程与讲解全是预写的演示数据；点过之后，点位与步行折线换成飞猪检索＋高德实测，
        只有那段预写讲解仍是演示文案——真实讲解在「在场探索」面板。
      </p>

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
    </details>
  );
}
