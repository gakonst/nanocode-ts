import type { DriveContext } from "durable-harness";
import type { MessageSocket } from "../index.ts";
import { bearerToken } from "../remote.ts";

type World = DriveContext["world"];

export type HandLine = { brain?: string; catalog?: string; closed?: boolean; connection?: string; frames?: string[] };

export const HAND_CONNECTION = /^[A-Za-z0-9_-]{8,64}$/;

export const DEFAULT_HOLD_MS = 240_000;

export type HandSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Uint8Array | string, isBinary: boolean) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type UpgradeWebSocket = (handler: (socket: HandSocket) => void | Promise<void>, options?: { maxPayload?: number }) => Promise<Response>;

type Brain = { receive(frame: string): void; shut(code: number, reason: string): void; lost(hand: LocalHand): void; rebind(hand: LocalHand): void };

type LocalHand = { connection: string; catalog: string; socket: HandSocket; brain?: Brain };

const OPEN = 1;

const local: Map<string, LocalHand> = ((globalThis as { [key: symbol]: unknown })[Symbol.for("nanocode-ts.vercel.hands")] ??= new Map()) as Map<string, LocalHand>;

const parked: Map<string, Brain> = ((globalThis as { [key: symbol]: unknown })[Symbol.for("nanocode-ts.vercel.parked")] ??= new Map()) as Map<string, Brain>;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

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

function frameWriter(write: (line: HandLine) => Promise<void>, failed: () => void): (brain: string, frame: string) => void {
  let pending: { brain: string; frames: string[] }[] = [];
  let writing = false;
  const pump = async () => {
    while (pending.length) {
      const lines = pending;
      pending = [];
      for (const line of lines) {
        try {
          await write(line);
        } catch {
          writing = false;
          failed();
          return;
        }
      }
    }
    writing = false;
  };
  return (brain, frame) => {
    const last = pending.at(-1);
    if (last?.brain === brain) last.frames.push(frame);
    else pending.push({ brain, frames: [frame] });
    if (writing) return;
    writing = true;
    queueMicrotask(() => void pump());
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

function dialLocal(world: World, runId: string, first: LocalHand, resumes: boolean): MessageSocket {
  const listeners: Record<"close" | "error" | "message", ((event: any) => void)[]> = { close: [], error: [], message: [] };
  const emit = (type: "close" | "error" | "message", event: unknown) => {
    for (const listener of listeners[type]) listener(event);
  };
  let closed = false;
  let current: LocalHand | undefined = first;
  let catalog = first.catalog;
  let held: string[] | undefined = [];
  let queued: string[] = [];
  let watching: AbortController | undefined;
  const brain: Brain = {
    receive(frame) {
      if (held) held.push(frame);
      else emit("message", { data: frame });
    },
    shut(code, reason) {
      if (closed) return;
      closed = true;
      watching?.abort();
      if (current?.brain === brain) current.brain = undefined;
      if (parked.get(runId) === brain) parked.delete(runId);
      emit("close", { code, reason });
    },
    lost(hand) {
      if (closed || current !== hand) return;
      if (!resumes) return brain.shut(1011, "the hand disconnected");
      current = undefined;
      parked.set(runId, brain);
      watching = new AbortController();
      void elsewhere(world, runId, watching.signal, () => brain.shut(1011, "the hand reconnected to another instance"));
    },
    rebind(hand) {
      if (closed) return;
      if (!resumes) return brain.shut(1011, "the hand reconnected");
      watching?.abort();
      watching = undefined;
      if (parked.get(runId) === brain) parked.delete(runId);
      if (current?.brain === brain) current.brain = undefined;
      current = hand;
      hand.brain = brain;
      if (held) catalog = hand.catalog;
      else emit("message", { data: hand.catalog });
      const frames = queued;
      queued = [];
      for (const frame of frames) hand.socket.send(frame);
    },
  };
  parked.get(runId)?.shut(1011, "the hand moved to a newer brain");
  first.brain?.shut(1011, "the hand moved to a newer brain");
  first.brain = brain;
  setTimeout(() => {
    const frames = held ?? [];
    held = undefined;
    if (closed) return;
    emit("message", { data: catalog });
    for (const frame of frames) emit("message", { data: frame });
  }, 0);
  return {
    send(message: string) {
      if (closed) throw new Error("the hand disconnected");
      if (current?.socket.readyState === OPEN) current.socket.send(message);
      else if (resumes) queued.push(message);
      else throw new Error("the hand disconnected");
    },
    close(code?: number, reason?: string) {
      brain.shut(code ?? 1000, reason ?? "");
    },
    addEventListener(type: "close" | "error" | "message", listener: (event: any) => void) {
      listeners[type].push(listener);
    },
  };
}

async function elsewhere(world: World, runId: string, signal: AbortSignal, moved: () => void): Promise<void> {
  const attach = handStreams(runId).attach;
  const info = await world.streams.getInfo(runId, attach).catch(() => undefined);
  for await (const [, line] of tailLines(world, runId, attach, (info?.tailIndex ?? -1) + 1, signal)) {
    if (line.catalog === undefined || line.connection === local.get(runId)?.connection) continue;
    moved();
    return;
  }
}

async function attachedHand(world: World, runId: string, signal: AbortSignal): Promise<{ current?: HandLine; attached: AsyncGenerator<[number, HandLine]> } | undefined> {
  const attach = handStreams(runId).attach;
  const info = await world.streams.getInfo(runId, attach).catch(() => undefined);
  if (!info || info.tailIndex < 0) return undefined;
  const attached = tailLines(world, runId, attach, Math.max(0, info.tailIndex - 15), signal);
  let current: HandLine | undefined;
  for (;;) {
    const next = await attached.next();
    if (next.done) break;
    const [index, line] = next.value;
    if (line.closed) {
      if (current?.connection === line.connection) current = undefined;
    } else if (line.catalog !== undefined && typeof line.connection === "string" && HAND_CONNECTION.test(line.connection)) current = line;
    if (index > info.tailIndex) break;
  }
  return { ...(current ? { current } : {}), attached };
}

function handName(catalog: string): string | null {
  try {
    const name = (JSON.parse(catalog) as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

export async function attachedHands(world: World, runId: string): Promise<(string | null)[]> {
  const nearby = local.get(runId);
  if (nearby?.socket.readyState === OPEN) return [handName(nearby.catalog)];
  const stop = new AbortController();
  try {
    const found = await attachedHand(world, runId, stop.signal);
    return found?.current?.catalog !== undefined ? [handName(found.current.catalog)] : [];
  } finally {
    stop.abort();
  }
}

export type DialOptions = { resumes?: boolean };

export async function dialHand(world: World, runId: string, signal: AbortSignal, options: DialOptions = {}): Promise<MessageSocket> {
  const resumes = options.resumes === true;
  const nearby = local.get(runId);
  if (nearby && nearby.socket.readyState === OPEN) return dialLocal(world, runId, nearby, resumes);
  const watch = new AbortController();
  const dialing = () => watch.abort();
  signal.addEventListener("abort", dialing, { once: true });
  let found: { current?: HandLine; attached: AsyncGenerator<[number, HandLine]> } | undefined;
  try {
    found = await attachedHand(world, runId, watch.signal);
  } finally {
    signal.removeEventListener("abort", dialing);
  }
  const current = found?.current;
  if (!found || !current || watch.signal.aborted) {
    watch.abort();
    throw new Error("no hand is attached to this session");
  }
  const attached = found.attached;
  let connection = current.connection!;
  const catalog = current.catalog!;
  const named = handStreams(runId, connection);
  const up = await world.streams.getInfo(runId, named.up).catch(() => ({ tailIndex: -1 }));
  const brain = handId();
  const listeners: Record<"close" | "error" | "message", ((event: any) => void)[]> = { close: [], error: [], message: [] };
  const emit = (type: "close" | "error" | "message", event: unknown) => {
    for (const listener of listeners[type]) listener(event);
  };
  let closed = false;
  let lost = false;
  let queued: string[] = [];
  let following = new AbortController();
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    watch.abort();
    following.abort();
    void attached.return(undefined);
    emit("close", { code, reason });
  };
  const writer = (to: string) => frameWriter(appendLines(world, runId, handStreams(runId, to).down), () => close(1011, "the hand stream refused a frame"));
  let write = writer(connection);
  const follow = async (name: string, start: number, stop: AbortSignal) => {
    for await (const [, line] of tailLines(world, runId, name, start, stop)) {
      if (closed) return;
      if (line.brain !== brain) continue;
      for (const frame of line.frames ?? []) emit("message", { data: frame });
    }
  };
  setTimeout(() => {
    if (closed) return;
    emit("message", { data: catalog });
    void follow(named.up, up.tailIndex + 1, following.signal);
    void (async () => {
      for (;;) {
        const next = await attached.next().catch(() => ({ done: true as const, value: undefined }));
        if (next.done || closed) return;
        const line = next.value[1];
        if (line.closed) {
          if (line.connection !== connection) continue;
          if (!resumes) return close(1011, "the hand disconnected");
          lost = true;
          continue;
        }
        if (line.catalog === undefined || typeof line.connection !== "string" || !HAND_CONNECTION.test(line.connection) || line.connection === connection) continue;
        if (!resumes) return close(1011, "the hand reconnected");
        following.abort();
        following = new AbortController();
        connection = line.connection;
        write = writer(connection);
        lost = false;
        emit("message", { data: line.catalog });
        void follow(handStreams(runId, connection).up, 0, following.signal);
        const frames = queued;
        queued = [];
        for (const frame of frames) write(brain, frame);
      }
    })();
  }, 0);
  return {
    send(message: string) {
      if (closed) throw new Error("the hand disconnected");
      if (lost) queued.push(message);
      else write(brain, message);
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
  maxFrameBytes?: number;
};

function serveSocket(world: World, sessionId: string, socket: HandSocket): void {
  const connection = handId();
  const streams = handStreams(sessionId, connection);
  const attach = appendLines(world, sessionId, streams.attach);
  const up = frameWriter(appendLines(world, sessionId, streams.up), () => socket.close(1011, "the hand stream refused a frame"));
  const stop = new AbortController();
  let hand: LocalHand | undefined;
  let brain: string | undefined;
  socket.on("message", (data, binary) => {
    if (binary) return socket.close(1003, "remote code mode requires JSON text frames");
    const frame = typeof data === "string" ? data : decoder.decode(data);
    if (!hand) {
      hand = { connection, catalog: frame, socket };
      const waiting = parked.get(sessionId) ?? local.get(sessionId)?.brain;
      local.set(sessionId, hand);
      waiting?.rebind(hand);
      void attach({ catalog: frame, connection }).catch(() => socket.close(1011, "the hand stream refused the catalog"));
      void (async () => {
        for await (const [, line] of tailLines(world, sessionId, streams.down, 0, stop.signal)) {
          if (typeof line.brain === "string") brain = line.brain;
          for (const sent of line.frames ?? []) if (socket.readyState === OPEN) socket.send(sent);
        }
      })();
      return;
    }
    if (hand.brain) return hand.brain.receive(frame);
    if (brain) up(brain, frame);
  });
  const closed = () => {
    if (stop.signal.aborted) return;
    stop.abort();
    if (!hand) return;
    if (local.get(sessionId) === hand) local.delete(sessionId);
    hand.brain?.lost(hand);
    void attach({ closed: true, connection }).catch(() => undefined);
  };
  socket.on("close", closed);
  socket.on("error", closed);
}

export function handRoute(options: HandRouteOptions) {
  const known = new Map<string, Promise<boolean>>();
  const admit = async (url: URL, bearer = ""): Promise<{ sessionId: string; channel: string } | Response> => {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const channel = url.searchParams.get("hand") ?? bearer;
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

  async function SOCKET(request: Request, upgrade: UpgradeWebSocket): Promise<Response> {
    const bearer = bearerToken(request);
    const admitted = await admit(new URL(request.url), bearer);
    if (admitted instanceof Response) return new Response(admitted.body, { status: 403 });
    const world = await options.world();
    return upgrade(socket => serveSocket(world, admitted.sessionId, socket), { maxPayload: options.maxFrameBytes ?? 1_048_576 });
  }

  return { GET, POST, SOCKET };
}