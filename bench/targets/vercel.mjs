const BASE = process.env.VERCEL_BASE ?? "https://nanocode.xyz/vercel/api/chat";

export async function run({ probe, provider, model }) {
  const started = Date.now();
  const res = await fetch(BASE, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ harness: provider, model, text: probe.prompt }), signal: AbortSignal.timeout(300000) }).catch(e => ({ ok: false, status: 0, text: async () => String(e) }));
  if (!res.ok) return { status: "http " + res.status, error: (await res.text()).slice(0, 200), wall_ms: Date.now() - started };
  const events = []; const dec = new TextDecoder(); let buf = ""; const reader = res.body.getReader();
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); if (/^event: end/m.test(block)) { reader.cancel().catch(() => {}); break; } const data = block.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join(""); if (data) try { events.push(JSON.parse(data)); } catch {} } } } catch {}
  const turn = events.find(e => e.type === "turn");
  const texts = new Map(); for (const e of events) if (e.type === "text") texts.set(e.item, (texts.get(e.item) ?? "") + (e.delta ?? ""));
  return {
    status: turn?.status ?? "no result", error: turn?.error ? JSON.stringify(turn.error).slice(0, 200) : undefined,
    text: [...texts.values()].join("\n\n"), wall_ms: Date.now() - started,
    calls: events.filter(e => e.type === "usage").map(u => ({ input: u.input_tokens ?? 0, cached: u.cached_tokens ?? 0, output: u.output_tokens ?? 0, ms: u.duration_ms ?? 0 })), child_calls: [],
    cells: events.filter(e => e.type === "tool_end" && !e.parent && (e.name === "exec" || e.name === "wait")).map(e => ({ ms: (e.duration_ns ?? 0) / 1e6, ok: e.status !== "failed" })),
    tool_failures: events.filter(e => e.type === "tool_end" && e.status === "failed").length,
    subagents: events.filter(e => e.type === "tool_start" && e.name === "spawn_agent").length,
  };
}
