import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { corpus } from "./trips-rag-corpus.mjs";

if (!process.argv.includes("--live")) throw new Error("This evaluator uses billed embeddings. Pass --live explicitly.");
process.env.TRIP_DATA_DIR ||= path.resolve(".data/trips-verification");
const { realProviders } = await import("../src/lib/server/trips/providers.ts");
const { retrieve } = await import("../src/lib/trips/retrieval.ts");
const tripId = "rag-evaluation";
const passages = await realProviders.embed(tripId, corpus.map((d) => d.text));
const queries = corpus.flatMap((d) => d.queries.map((query) => ({ query, target: d.id })));
const vectors = await realProviders.embed(tripId, queries.map((q) => q.query));
const chunks = corpus.map((d, i) => ({ id: d.id, materialId: d.id, materialVersion: 1, ordinal: 0, text: d.text, vector: passages[i], model: "text-embedding-v4:512" }));
const results = queries.map((item, i) => {
  const ids = retrieve(chunks, item.query, vectors[i]).map((c) => c.id);
  return { ...item, retrieved: ids, hit: ids.includes(item.target) };
});
const hits = results.filter((r) => r.hit).length;
const report = { at: new Date().toISOString(), model: "text-embedding-v4", dimensions: 512,
  corpus: "10 authored fixture passages, not live travel recommendations", hits, total: queries.length,
  acceptance: hits >= 18, results };
fs.mkdirSync("output/playwright", { recursive: true });
fs.writeFileSync("output/playwright/rag-live-evaluation.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ hits, total: queries.length, acceptance: report.acceptance }));
assert.ok(report.acceptance, "Need at least 18/20 targets within the six retrieved passages.");
