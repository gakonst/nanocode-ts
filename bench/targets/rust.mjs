import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NC = process.env.NC ?? "nc";

function spans(home) {
  const root = join(home, "log", "otel");
  const out = [];
  for (const dir of (() => { try { return readdirSync(root); } catch { return []; } })()) {
    let text = ""; try { text = readFileSync(join(root, dir, "traces.jsonl"), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      for (const rs of JSON.parse(line).resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) {
        const attrs = Object.fromEntries((s.attributes ?? []).map(a => [a.key, Object.values(a.value ?? {})[0]]));
        out.push({ name: s.name, ms: (Number(s.endTimeUnixNano) - Number(s.startTimeUnixNano)) / 1e6, attrs });
      }
    }
  }
  return out;
}

export async function run({ probe, model }) {
  const home = mkdtempSync(join(tmpdir(), "nc-home-"));
  const dir = mkdtempSync(join(tmpdir(), "nc-bench-"));
  const args = ["exec", "--home", home, "-m", model, "-C", dir, "--telemetry", "agent", probe.prompt];
  const started = Date.now();
  const { code, stdout, stderr } = await new Promise(resolve => {
    const child = spawn(NC, args, { cwd: dir, env: process.env });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 300000);
    child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  const wall_ms = Date.now() - started;
  const all = spans(home);
  rmSync(home, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
  const depth = new Map(all.filter(s => s.name === "agent.turn").map(s => [s.attrs["session.id"], Number(s.attrs["agent.depth"] ?? 0)]));
  const deep = s => (depth.get(s.attrs["session.id"]) ?? 0) > 0;
  const call = s => ({ input: Number(s.attrs.input_tokens ?? 0), cached: Number(s.attrs.cached_input_tokens ?? 0), output: Number(s.attrs.output_tokens ?? 0), ms: s.ms });
  const calls = all.filter(s => s.name === "model.call");
  return {
    status: code === 0 ? "completed" : "exit " + code, error: code === 0 ? undefined : stderr.slice(-300),
    text: stdout, wall_ms,
    calls: calls.filter(s => !deep(s)).map(call), child_calls: calls.filter(deep).map(call),
    cells: all.filter(s => s.name === "code_mode.cell" && !deep(s)).map(s => ({ ms: s.ms, ok: true })),
    tool_failures: 0,
    subagents: [...depth.values()].filter(d => d > 0).length,
  };
}
