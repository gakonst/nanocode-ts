import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { probes } from "./probes.mjs";

const MODELS = { haiku: ["claude", "claude-haiku-5-5"], sonnet: ["claude", "claude-sonnet-5-5"], cglm: ["claude", "zai/glm-5.3"], ckimi: ["claude", "moonshotai/kimi-k3"], sol: ["codex", "gpt-6.1-sol"], luna: ["codex", "gpt-6-luna"], glm: ["codex", "glm-5.3"], kimi: ["codex", "kimi-k3"] };
const arg = (name, fallback) => process.argv.find(a => a.startsWith("--" + name + "="))?.split("=")[1] ?? fallback;
const targets = arg("targets", "cloudflare").split(",");
const models = arg("models", "haiku,sol,glm").split(",");
const only = arg("probes", "") ? arg("probes", "").split(",") : null;
const conc = Number(arg("conc", "1"));
const label = arg("label", new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"));
const chosen = probes.filter(p => !only || only.includes(p.id));

const jobs = [];
for (const target of targets) for (const m of models) for (const probe of chosen) if (!probe.providers || probe.providers.includes((MODELS[m] ?? ["codex"])[0])) jobs.push({ target, model: m, probe });
mkdirSync("bench/out", { recursive: true });
const file = "bench/out/" + label + ".jsonl";
writeFileSync(file, "");
const drivers = {};
const results = [];
let next = 0;
await Promise.all(Array.from({ length: conc }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    drivers[job.target] ??= await import("./targets/" + job.target + ".mjs");
    const [provider, model] = MODELS[job.model] ?? ["codex", job.model];
    let r;
    try { r = await drivers[job.target].run({ probe: job.probe, provider, model, label }); } catch (e) { r = { status: "harness error", error: String(e).slice(0, 200), wall_ms: 0 }; }
    r.calls ??= []; r.child_calls ??= []; r.cells ??= [];
    const ok = r.status === "completed" && job.probe.ok(r.text ?? "", r);
    const row = { target: job.target, model: job.model, probe: job.probe.id, tools: job.probe.tools, ok, ...r };
    results.push(row);
    appendFileSync(file, JSON.stringify(row) + "\n");
    console.error((ok ? "PASS " : "FAIL ") + [job.target, job.model, job.probe.id, r.status, (r.wall_ms / 1000).toFixed(1) + "s"].join(" "));
  }
}));

const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
const avg = (xs, f) => xs.length ? sum(xs, f) / xs.length : 0;
const pad = (s, n) => String(s).padEnd(n);
const lines = [];
lines.push("nanocode bench " + label + " (" + results.length + " runs)", "");
lines.push([pad("target", 11), pad("model", 7), pad("pass", 7), pad("wall s", 7), pad("calls", 6), pad("1st in", 7), pad("in/turn", 8), pad("cached", 7), pad("model s", 8), pad("cells s", 8), pad("open s", 7), pad("host s", 7), "host%"].join(" "));
for (const target of targets) for (const m of models) {
  const rows = results.filter(r => r.target === target && r.model === m);
  if (!rows.length) continue;
  const all = r => [...r.calls, ...r.child_calls];
  const inp = avg(rows, r => sum(all(r), c => c.input)), cached = sum(rows, r => sum(all(r), c => c.cached)) / Math.max(1, sum(rows, r => sum(all(r), c => c.input)));
  const modelS = avg(rows, r => sum(r.calls, c => c.ms)) / 1000, cellS = avg(rows, r => sum(r.cells, c => c.ms)) / 1000, wall = avg(rows, r => r.wall_ms) / 1000;
  const openS = avg(rows, r => r.open_ms ?? 0) / 1000;
  const host = Math.max(0, wall - modelS - cellS - openS);
  lines.push([pad(target, 11), pad(m, 7), pad(rows.filter(r => r.ok).length + "/" + rows.length, 7), pad(wall.toFixed(1), 7), pad(avg(rows, r => all(r).length).toFixed(1), 6), pad(Math.round(avg(rows, r => r.calls[0]?.input ?? 0)), 7), pad(Math.round(inp), 8), pad((100 * cached).toFixed(1) + "%", 7), pad(modelS.toFixed(1), 8), pad(cellS.toFixed(2), 8), pad(openS.toFixed(2), 7), pad(host.toFixed(2), 7), (wall ? 100 * host / wall : 0).toFixed(1) + "%"].join(" "));
}
lines.push("", "wall = model + cells + open (cold runtime start, Cloudflare only) + host (everything else: transport, durable writes, queueing). Workers freeze timers between I/O, so Cloudflare cells read 0 and their time falls in host.");
lines.push("", "pass grid (rows: probe; columns: target/model)");
const cols = targets.flatMap(t => models.map(m => t + "/" + m)).filter(c => results.some(r => r.target + "/" + r.model === c));
lines.push(pad("probe", 11) + cols.map(c => pad(c, Math.max(c.length, 4) + 1)).join(""));
for (const probe of chosen) lines.push(pad(probe.id, 11) + cols.map(c => { const r = results.find(x => x.target + "/" + x.model === c && x.probe === probe.id); return pad(!r ? "-" : r.ok ? "ok" : r.status === "completed" ? "x" : "ERR", Math.max(c.length, 4) + 1); }).join(""));
const failed = results.filter(r => !r.ok);
if (failed.length) { lines.push("", "failures"); for (const r of failed) lines.push("- " + [r.target, r.model, r.probe, r.status, (r.error ?? (r.text ?? "").replace(/\s+/g, " ")).slice(0, 160)].join(" | ")); }
const report = lines.join("\n");
writeFileSync("bench/out/" + label + ".txt", report + "\n");
console.log(report);
