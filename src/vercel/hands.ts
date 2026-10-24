import type { DriveContext } from "durable-harness";
import type { MessageSocket } from "../index.ts";

type World = DriveContext["world"];

export type HandLine = { brain?: string; catalog?: string; closed?: boolean; connection?: string; frames?: string[] };

export const HAND_CONNECTION = /^[A-Za-z0-9_-]{8,64}$/;

export const DEFAULT_HOLD_MS = 240_000;

const encoder = new TextEncoder();

export function handStreams(runId: string, connection = "") {
  return { attach: runId + "_hand", down: runId + "_hand_down_" + connection, up: runId + "_hand_up_" + connection };
}

export function handId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function appendLines(world: World, runId: string, name: string): (line: HandLine) => Promise<void> {
  let tail = Promise.resolve();
  return line => {
    const next = tail.then(() => world.streams.write(runId, name, encoder.encode(JSON.stringify(line) + "\n")));
    tail = next.catch(() => undefined);
    return next;
  };
}

export async function* tailLines(world: World, runId: string, name: string, start: number, signal: AbortSignal): AsyncGenerator<[number, HandLine]> {
  let index = start;
  while (!signal.aborted) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => void reader?.cancel().catch(() => undefined);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      reader = (await world.streams.get(runId, name, index)).getReader();
      if (signal.aborted) cancel();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (!line) continue;
          index++;
          yield [index, JSON.parse(line) as HandLine];
        }
      }
      if (signal.aborted) return;
      const info = await world.streams.getInfo(runId, name).catch(() => undefined);
      if (info?.done) return;
    } catch {
      if (signal.aborted) return;
    } finally {
      signal.removeEventListener("abort", cancel);
      try { reader?.releaseLock(); } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

export async function dialHand(world: World, runId: string, signal: AbortSignal): Promise<MessageSocket> {
  const streams = handStreams(runId);
  const info = await world.streams.getInfo(runId, streams.attach).catch(() => undefined);
  if (!info || info.tailIndex < 0) throw new Error("no hand is attached to this session");
  const watch = new AbortController();
  const dialing = () => watch.abort();
  signal.addEventListener("abort", dialing, { once: true });
  const attached = tailLines(world, runId, streams.attach, Math.max(0, info.tailIndex - 15), watch.signal);
  let current: HandLine | undefined;
  try {
    for (;;) {
      const next = await attached.next();
      if (next.done) break;
      const [index, line] = next.value;
      if (line.closed) {
        if (current?.connection === line.connection) current = undefined;
      } else if (line.catalog !== undefined && typeof line.connection === "string" && HAND_CONNECTION.test(line.connection)) current = line;
      if (index > info.tailIndex) break;
    }
  } finally {
    signal.removeEventListener("abort", dialing);
  }
  if (!current || watch.signal.aborted) {
    watch.abort();
    throw new Error("no hand is attached to this session");
  }
  const connection = current.connection!;
  const catalog = current.catalog!;
  const named = handStreams(runId, connection);
  const up = await world.streams.getInfo(runId, named.up).catch(() => ({ tailIndex: -1 }));
  const brain = handId();
  const write = appendLines(world, runId, named.down);
  const listeners: Record<"close" | "error" | "message", ((event: any) => void)[]> = { close: [], error: [], message: [] };
  const emit = (type: "close" | "error" | "message", event: unknown) => {
    for (const listener of listeners[type]) listener(event);
  };
  let closed = false;
  let pending: string[] = [];
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    watch.abort();
    void attached.return(undefined);
    emit("close", { code, reason });
  };
  const flush = () => {
    const frames = pending;
    pending = [];
    if (frames.length) void write({ brain, frames }).catch(() => close(1011, "the hand stream refused a frame"));
  };
  setTimeout(() => {
    if (closed) return;
    emit("message", { data: catalog });
    void (async () => {
      for await (const [, line] of tailLines(world, runId, named.up, up.tailIndex + 1, watch.signal)) {
        if (closed) return;
        if (line.brain !== brain) continue;
        for (const frame of line.frames ?? []) emit("message", { data: frame });
      }
    })();
    void (async () => {
      for (;;) {
        const next = await attached.next().catch(() => ({ done: true as const, value: undefined }));
        if (next.done || closed) return;
        const line = next.value[1];
        if (line.closed && line.connection !== connection) continue;
        close(1011, line.closed ? "the hand disconnected" : "the hand reconnected");
        return;
      }
    })();
  }, 0);
  return {
    send(message: string) {
      if (closed) throw new Error("the hand disconnected");
      if (!pending.length) queueMicrotask(flush);
      pending.push(message);
    },
    close(code?: number, reason?: string) {
      close(code ?? 1000, reason ?? "");
    },
    addEventListener(type: "close" | "error" | "message", listener: (event: any) => void) {
      listeners[type].push(listener);
    },
  };
}

export type HandRouteOptions = {
  world(): Promise<World>;
  owns(sessionId: string, channel: string): Promise<boolean>;
  holdMs?: number;
};

export function handRoute(options: HandRouteOptions) {
  const known = new Map<string, Promise<boolean>>();
  const admit = async (url: URL): Promise<{ sessionId: string; channel: string } | Response> => {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const channel = url.searchParams.get("hand") ?? "";
    if (!sessionId || !/^[A-Za-z0-9_-]{8,128}$/.test(sessionId) || !/^[A-Za-z0-9_-]{16,64}$/.test(channel)) return new Response("sessionId and hand must name a session and its hand channel", { status: 400 });
    const key = sessionId + "/" + channel;
    let owned = known.get(key);
    if (!owned) {
      owned = options.owns(sessionId, channel).catch(() => false);
      known.set(key, owned);
      void owned.then(yes => { if (!yes) known.delete(key); });
    }
    if (!await owned) return new Response("this session has no hand on that channel", { status: 404 });
    return { sessionId, channel };
  };

  async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const admitted = await admit(url);
    if (admitted instanceof Response) return admitted;
    const connection = url.searchParams.get("connection") ?? "";
    if (!HAND_CONNECTION.test(connection)) return new Response("connection must name the hand's connection", { status: 400 });
    const cursor = Number(url.searchParams.get("cursor") ?? request.headers.get("last-event-id") ?? 0);
    const start = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    const world = await options.world();
    const name = handStreams(admitted.sessionId, connection).down;
    const stop = new AbortController();
    const hold = setTimeout(() => stop.abort(), options.holdMs ?? DEFAULT_HOLD_MS);
    request.signal.addEventListener("abort", () => stop.abort(), { once: true });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(": attached\n\n"));
        try {
          for await (const [index, line] of tailLines(world, admitted.sessionId, name, start, stop.signal)) controller.enqueue(encoder.encode("id: " + index + "\ndata: " + JSON.stringify(line) + "\n\n"));
        } catch {}
        clearTimeout(hold);
        try { controller.close(); } catch {}
      },
      cancel() {
        clearTimeout(hold);
        stop.abort();
      },
    });
    return new Response(body, { headers: { "cache-control": "no-cache, no-transform", "content-type": "text/event-stream", "x-accel-buffering": "no" } });
  }

  async function POST(request: Request): Promise<Response> {
    const admitted = await admit(new URL(request.url));
    if (admitted instanceof Response) return admitted;
    const body = await request.json().catch(() => undefined) as { brain?: unknown; catalog?: unknown; close?: unknown; connection?: unknown; frames?: unknown } | undefined;
    if (!body || typeof body.connection !== "string" || !HAND_CONNECTION.test(body.connection)) return new Response("connection must name the hand's connection", { status: 400 });
    const world = await options.world();
    const streams = handStreams(admitted.sessionId, body.connection);
    if (body.close === true) {
      await appendLines(world, admitted.sessionId, streams.attach)({ closed: true, connection: body.connection });
      return new Response(null, { status: 204 });
    }
    if (typeof body.catalog === "string") {
      await appendLines(world, admitted.sessionId, streams.attach)({ catalog: body.catalog, connection: body.connection });
      return new Response(null, { status: 204 });
    }
    if (typeof body.brain !== "string" || !Array.isArray(body.frames) || !body.frames.every(frame => typeof frame === "string")) return new Response("frames must be strings sent to a brain", { status: 400 });
    await appendLines(world, admitted.sessionId, streams.up)({ brain: body.brain, frames: body.frames as string[] });
    return new Response(null, { status: 204 });
  }

  return { GET, POST };
}
