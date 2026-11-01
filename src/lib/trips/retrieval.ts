import type { SourceChunk } from "./types.ts";

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const concepts: Record<string, string[]> = {
  安静: ["人少", "清静", "宁静", "独处", "清幽"], 拍照: ["摄影", "出片", "机位"],
  日落: ["夕阳", "傍晚", "落日"], 免费: ["免票", "不收费"], 步行: ["走路", "徒步"],
};
export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
export function terms(text: string): string[] {
  const normalized = normalizeText(text);
  const result = [...segmenter.segment(normalized)].filter((item) => item.isWordLike).map((item) => item.segment);
  for (const [key, aliases] of Object.entries(concepts)) {
    if ([key, ...aliases].some((word) => normalized.includes(word))) result.push("concept:" + key);
  }
  return result;
}
export function splitChunks(text: string): string[] {
  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > 600) {
      out.push(current);
      current = current.slice(-80);
    }
    current = (current ? current + "\n\n" : "") + paragraph;
    while (current.length > 680) {
      out.push(current.slice(0, 600));
      current = current.slice(520);
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, an = 0, bn = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; an += a[i] ** 2; bn += b[i] ** 2; }
  return an && bn ? dot / Math.sqrt(an * bn) : 0;
}
export function retrieve(chunks: SourceChunk[], query: string, vector: number[] | null, aliases: string[][] = []): SourceChunk[] {
  const normalized = normalizeText(query);
  const related = aliases.filter((group) => group.some((name) => normalizeText(name) && normalized.includes(normalizeText(name)))).flat();
  const q = [...new Set(terms([query, ...related].join(" ")))];
  const documents = chunks.map((chunk) => ({ chunk, tokens: terms(chunk.text) }));
  const average = documents.reduce((n, d) => n + d.tokens.length, 0) / (documents.length || 1);
  const keyword = documents.map(({ chunk, tokens }) => {
    let score = 0;
    for (const term of q) {
      const tf = tokens.filter((t) => t === term).length;
      if (!tf) continue;
      const df = documents.filter((d) => d.tokens.includes(term)).length;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * tokens.length / (average || 1)));
    }
    return { chunk, score };
  }).filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
  const semantic = vector ? chunks.filter((c) => c.vector).map((chunk) => ({
    chunk, score: cosine(chunk.vector!, vector),
  })).filter((d) => d.score >= 0.35).sort((a, b) => b.score - a.score).slice(0, 20) : [];
  const scores = new Map<string, { chunk: SourceChunk; score: number }>();
  for (const list of [keyword, semantic]) list.forEach(({ chunk }, rank) => {
    const hit = scores.get(chunk.id) ?? { chunk, score: 0 };
    hit.score += 1 / (60 + rank + 1); scores.set(chunk.id, hit);
  });
  return [...scores.values()].sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .slice(0, 6).map((d) => d.chunk);
}
