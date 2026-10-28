import { readFileSync } from "node:fs";

const profile = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pattern = new RegExp(process.argv[3] ?? "nanocode");
const limit = Number(process.argv[4] ?? "50");
const byId = new Map(profile.nodes.map(node => [node.id, node]));
const parentOf = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parentOf.set(child, node.id);
const counts = new Map();
profile.samples.forEach((id, index) => counts.set(id, (counts.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0)));
const inclusive = new Map();
let total = 0;
for (const [id, time] of counts) {
  total += time;
  const seen = new Set();
  let current = id;
  while (current !== undefined) {
    const name = byId.get(current).callFrame.functionName || "(anonymous)";
    if (!seen.has(name)) { seen.add(name); inclusive.set(name, (inclusive.get(name) ?? 0) + time); }
    current = parentOf.get(current);
  }
}
const demangle = name => name.replace(/^_R[A-Za-z]+/, "").replace(/Cs[0-9A-Za-z]+_/g, "").replace(/\d+([a-z_][a-z0-9_]*)/gi, "$1:").slice(0, 160);
for (const [name, time] of [...inclusive].filter(([name]) => pattern.test(name)).sort((a, b) => b[1] - a[1]).slice(0, limit)) console.log((time / 1000).toFixed(0).padStart(6), "ms", (100 * time / total).toFixed(1).padStart(5) + "%", demangle(name));
