import type { Material } from "./types.ts";

/** Repeated content or the same declared source is one source, irrespective of uploader. */
export function independentSourceCount(materials: Material[], materialIds: string[]): number {
  const groups: Set<string>[] = [];
  for (const material of materials.filter((m) => materialIds.includes(m.id) && !m.deletedAt && m.status === "ready")) {
    const keys = ["source:" + material.sourceKey, "content:" + material.contentHash];
    const matches = groups.filter((g) => keys.some((key) => g.has(key)));
    const group = new Set(keys);
    for (const match of matches) for (const key of match) group.add(key);
    for (const match of matches) groups.splice(groups.indexOf(match), 1);
    groups.push(group);
  }
  return groups.length;
}
