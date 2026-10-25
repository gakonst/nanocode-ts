const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = process.env.CF_BASE ?? "https://nanocode-cloudflare-durable.tempo-dev.workers.dev/";
const AUTH = process.env.CF_TOKEN ? { authorization: "Bearer " + process.env.CF_TOKEN } : {};

function frames(text) { return text.split("\n\n").map(b => { const l = b.split("\n"); const id = l.find(x => x.startsWith("id: "))?.slice(4); const data = l.filter(x => x.startsWith("data: ")).map(x => x.slice(6)).join(""); return data ? { id, data } : null; }).filter(Boolean); }

async function fetchRetry(url, init) {
  for (let i = 0; i < 8; i++) { const r = await fetch(url, init); if (r.status !== 429) return r; await sleep(15000); }
  return fetch(url, init);
}

export async function run({ probe, provider, model, label }) {
  const session = "bench-" + label + "-" + probe.id + "-" + Math.random().toString(16).slice(2, 8);
  const requestId = "turn-" + Math.random().toString(16).slice(2, 10);
  const started = Date.now();
  let cursor = 0, done = false;
  for (let attempt = 0; attempt < 6 && !done && Date.now() - started < 300000; attempt++) {
    const url = attempt === 0 ? BASE + "sessions/" + session + "/turns" : BASE + "sessions/" + session + "/events?after=" + cursor;
    const init = attempt === 0 ? { method: "POST", headers: { ...AUTH, "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ request_id: requestId, prompt: probe.prompt, provider, model }) } : { headers: { ...AUTH, accept: "text/event-stream" } };
    let res; try { res = await fetchRetry(url, { ...init, signal: AbortSignal.timeout(300000) }); } catch { await sleep(2000); continue; }
    if (!res.ok) return { status: "http " + res.status, error: (await res.text()).slice(0, 200), wall_ms: Date.now() - started };
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    try { for (;;) { const { done: end, value } = await reader.read(); if (end) break; buf += dec.decode(value, { stream: true }); const cut = buf.lastIndexOf("\n\n"); if (cut < 0) continue; for (const m of frames(buf.slice(0, cut + 2))) { if (m.id) cursor = Number(m.id); if (/"type":"result"/.test(m.data) && m.data.includes(requestId)) done = true; } buf = buf.slice(cut + 2); if (done) { reader.cancel().catch(() => {}); break; } } } catch {}
  }
  const wall_ms = Date.now() - started;
  const logged = [];
  for (let after = 0, i = 0; i < 60; i++) { const r = await fetchRetry(BASE + "sessions/" + session + "/events?after=" + after + "&limit=128", { headers: AUTH }); const page = await r.json(); logged.push(...page.events); after = page.next_cursor; if (!page.has_more) break; }
  const result = logged.find(e => e.event?.type === "result" && e.request_id === requestId)?.event;
  const agent = logged.filter(e => e.event?.source === "agent").map(e => e.event.event);
  const sub = logged.filter(e => e.event?.source === "subagent");
  const subEvents = sub.map(e => e.event.update?.event).filter(Boolean);
  const call = e => { const u = e.payload.usage ?? {}; return { input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens ?? 0, ms: (e.payload.duration_ns ?? 0) / 1e6 }; };
  return {
    status: result?.status ?? "no result", error: result?.error,
    text: agent.filter(e => e.type === "assistant.message").map(e => e.payload.text).join("\n\n"),
    wall_ms,
    calls: agent.filter(e => e.type === "model.call.completed").map(call),
    child_calls: subEvents.filter(e => e.type === "model.call.completed").map(call),
    cells: agent.filter(e => e.type === "tool.result" && (e.payload.tool === "exec" || e.payload.tool === "wait")).map(e => ({ ms: (e.payload.duration_ns ?? 0) / 1e6, ok: e.payload.status !== "failed" })),
    tool_failures: agent.filter(e => e.type === "tool.result" && e.payload.status === "failed").length,
    subagents: sub.filter(e => e.event.update?.type === "added").length,
    open_ms: result?.timing?.runtime_open_ms ?? 0,
  };
}
