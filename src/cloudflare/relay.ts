import { DurableObject } from "cloudflare:workers";

export const RELAY_PATH = /^\/relay\/([A-Za-z0-9_-]{16,64})\/(hand|brain)$/;

type Side = "hand" | "brain";

export class HandRelay extends DurableObject {
  #hand: WebSocket | undefined;
  #brain: WebSocket | undefined;
  #catalog: string | undefined;

  override async fetch(request: Request): Promise<Response> {
    const side = new URL(request.url).pathname.split("/").pop() as Side;
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return Response.json({ hand: this.#hand !== undefined && this.#catalog !== undefined, brain: this.#brain !== undefined });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    if (side === "hand") this.#attachHand(server);
    else this.#attachBrain(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  #attachHand(socket: WebSocket) {
    const previous = this.#hand;
    this.#hand = socket;
    this.#catalog = undefined;
    try { previous?.close(1000, "another tab attached"); } catch {}
    try { this.#brain?.close(1011, "the hand reconnected"); } catch {}
    this.#brain = undefined;
    socket.addEventListener("message", event => {
      if (this.#hand !== socket) return;
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      if (this.#catalog === undefined) {
        this.#catalog = text;
        if (this.#brain) this.#brain.send(text);
        return;
      }
      try { this.#brain?.send(text); } catch {}
    });
    const gone = () => {
      if (this.#hand !== socket) return;
      this.#hand = undefined;
      this.#catalog = undefined;
      try { this.#brain?.close(1011, "the hand disconnected"); } catch {}
      this.#brain = undefined;
    };
    socket.addEventListener("close", gone);
    socket.addEventListener("error", gone);
  }

  #attachBrain(socket: WebSocket) {
    if (!this.#hand) {
      socket.close(1011, "no hand is attached to this channel");
      return;
    }
    const previous = this.#brain;
    this.#brain = socket;
    try { previous?.close(1000, "a newer drive attached"); } catch {}
    if (this.#catalog !== undefined) socket.send(this.#catalog);
    socket.addEventListener("message", event => {
      if (this.#brain !== socket) return;
      try { this.#hand?.send(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)); } catch {}
    });
    const gone = () => {
      if (this.#brain === socket) this.#brain = undefined;
    };
    socket.addEventListener("close", gone);
    socket.addEventListener("error", gone);
  }
}

export function relay(request: Request, namespace: DurableObjectNamespace<HandRelay>): Response | Promise<Response> | undefined {
  const match = RELAY_PATH.exec(new URL(request.url).pathname);
  if (!match) return undefined;
  return namespace.get(namespace.idFromName(match[1]!)).fetch(request);
}

