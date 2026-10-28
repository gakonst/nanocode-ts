import { DurableObject } from "cloudflare:workers";
import { BRAIN_REPLACED, bearerAccepted, bearerToken, HAND_ACCEPTED, HAND_LEFT } from "../remote.ts";

export const RELAY_TOKEN = /^[0-9a-f]{32,128}$/;

const HAND_REPLACED = "another hand attached under this name";

type Side = "hand" | "brain";

function text(message: string | ArrayBuffer): string {
  return typeof message === "string" ? message : new TextDecoder().decode(message);
}

function catalogField(catalog: string | undefined, field: "name" | "runtime_id"): string | null {
  if (catalog === undefined) return null;
  try {
    const value = (JSON.parse(catalog) as Record<string, unknown>)[field];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export class HandRelay extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams;
    const side: Side = query.get("role") === "brain" ? "brain" : "hand";
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      const hand = this.#hand();
      return Response.json({ hands: hand ? [catalogField(await this.ctx.storage.get<string>("catalog"), "name")] : [] }, { headers: { "cache-control": "no-store" } });
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [side]);
    if (side === "hand") server.send(HAND_ACCEPTED);
    if (side === "brain" && !query.has("wait") && !this.#hand()) server.close(HAND_LEFT, "no hand is attached");
    else if (side === "brain") {
      for (const older of this.ctx.getWebSockets("brain")) if (older !== server) { try { older.close(BRAIN_REPLACED, "a newer brain took the hand"); } catch {} }
      const catalog = await this.ctx.storage.get<string>("catalog");
      if (catalog !== undefined && this.#hand()) this.#offer(server, catalog);
    }
    return new Response(null, { status: 101, webSocket: client, headers: bearerAccepted(request) });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.ctx.getTags(socket)[0] === "hand") {
      if (socket.deserializeAttachment() !== null) {
        for (const brain of this.ctx.getWebSockets("brain")) if (brain.deserializeAttachment() !== null) { try { brain.send(message); } catch {} }
        return;
      }
      const catalog = text(message);
      const previous = catalogField(await this.ctx.storage.get<string>("catalog"), "runtime_id");
      const same = previous !== null && previous === catalogField(catalog, "runtime_id");
      for (const other of this.ctx.getWebSockets("hand")) if (other !== socket) { try { other.close(same ? 1000 : 1008, same ? "the hand reconnected" : HAND_REPLACED); } catch {} }
      socket.serializeAttachment({ cataloged: true });
      await this.ctx.storage.put("catalog", catalog);
      for (const brain of this.ctx.getWebSockets("brain")) {
        if (brain.deserializeAttachment() === null) this.#offer(brain, catalog);
        else { try { brain.close(HAND_LEFT, "the hand reconnected"); } catch {} }
      }
      return;
    }
    if (socket.deserializeAttachment() === null) return;
    const hand = this.#hand();
    if (hand) { try { hand.send(message); } catch {} }
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    await this.#gone(socket);
    try { socket.close(code, reason); } catch {}
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.#gone(socket);
  }

  #offer(brain: WebSocket, catalog: string): void {
    try {
      brain.send(catalog);
      brain.serializeAttachment({ cataloged: true });
    } catch {}
  }

  #hand(): WebSocket | undefined {
    return this.ctx.getWebSockets("hand").find(socket => socket.readyState === WebSocket.OPEN && socket.deserializeAttachment() !== null);
  }

  async #gone(socket: WebSocket): Promise<void> {
    if (this.ctx.getTags(socket)[0] !== "hand" || socket.deserializeAttachment() === null) return;
    if (this.ctx.getWebSockets("hand").some(other => other !== socket && other.readyState === WebSocket.OPEN && other.deserializeAttachment() !== null)) return;
    await this.ctx.storage.delete("catalog");
    for (const brain of this.ctx.getWebSockets("brain")) { try { brain.close(HAND_LEFT, "the hand disconnected"); } catch {} }
  }
}

export function relayToken(request: Request): string | undefined {
  const token = bearerToken(request) ?? new URL(request.url).searchParams.get("token") ?? "";
  return RELAY_TOKEN.test(token) ? token : undefined;
}

export function refuseSocket(request: Request, reason: string, status: number): Response {
  const accepted = bearerAccepted(request);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || !accepted["sec-websocket-protocol"]) return Response.json({ error: reason }, { status });
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();
  server.close(1008, reason.slice(0, 120));
  return new Response(null, { status: 101, webSocket: client, headers: accepted });
}

export function relay(request: Request, namespace: DurableObjectNamespace<HandRelay>): Response | Promise<Response> {
  const token = relayToken(request);
  if (!token) return refuseSocket(request, "hands and brains connect with the relay's token, as Authorization: Bearer, the bearer WebSocket subprotocol or ?token=", 403);
  return namespace.get(namespace.idFromName(token)).fetch(request);
}
