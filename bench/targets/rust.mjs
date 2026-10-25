import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NC = process.env.NC ?? "nc";
const GLM = ["--gateway", "cloudflare", "--cloudflare-account", process.env.CLOUDFLARE_ACCOUNT_ID ?? ""];
const ms = value => { const m = /^([\d.]+)(ns|µs|us|ms|s)$/.exec(value ?? ""); if (!m) return 0; return Number(m[1]) * { ns: 1e-6, "µs": 1e-3, us: 1e-3, ms: 1, s: 1000 }[m[2]]; };

export async function run({ probe, model }) {
  const dir = mkdtempSync(join(tmpdir(), "nc-bench-"));
  const log = join(dir, ".nc.log");
  const args = ["exec", "--ephemeral", "-m", model, "-C", dir, "--log-format", "json", "--log-file", log, ...(model === "glm-5.3" ? GLM : []), probe.prompt];
  const started = Date.now();
  const { code, stdout, stderr } = await new Promise(resolve => {
    const child = spawn(NC, args, { cwd: dir, env: process.env });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 300000);
    child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  const wall_ms = Date.now() - started;
  const lines = (() => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } })();
  rmSync(dir, { recursive: true, force: true });
  const closes = lines.filter(l => l.fields?.message === "close" && l.spans?.length);
  const last = l => l.spans.at(-1);
  const dur = l => ms(l.fields["time.busy"]) + ms(l.fields["time.idle"]);
  const depth = l => l.spans[0]["agent.depth"] ?? 0;
  const seen = new Set();
  const calls = closes.filter(l => last(l).name === "model.call" && last(l)["model.response.id"] && !seen.has(last(l)["model.response.id"]) && seen.add(last(l)["model.response.id"])).map(l => ({ depth: depth(l), input: last(l).input_tokens ?? 0, cached: last(l).cached_input_tokens ?? 0, output: last(l).output_tokens ?? 0, ms: dur(l) }))
    .concat(closes.filter(l => last(l).name === "responses.attempt" && l.target === "nanocode_codex").map(l => ({ depth: depth(l), input: 0, cached: 0, output: 0, ms: dur(l) })));
  const cells = closes.filter(l => last(l).name === "tool.call" && ["exec", "wait"].includes(last(l)["tool.name"])).map(l => ({ ms: dur(l), ok: true }));
  return {
    status: code === 0 ? "completed" : "exit " + code, error: code === 0 ? undefined : stderr.slice(-300),
    text: stdout, wall_ms,
    calls: calls.filter(c => c.depth === 0), child_calls: calls.filter(c => c.depth > 0),
    cells, tool_failures: (stderr.match(/✗|failed/g) ?? []).length,
    subagents: new Set(lines.filter(l => (l.spans?.[0]?.["agent.depth"] ?? 0) > 0).map(l => l.spans[0]["session.id"])).size,
  };
}
