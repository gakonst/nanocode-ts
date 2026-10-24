import { durableAgent, getWorld, type HostTool } from "durable-harness";
import { handRoute } from "./hands.ts";
import { HAND_CHANNEL, nanocodeHarness, type NanocodeHarnessOptions, type NanocodeSession, type ServiceTier, type Thinking } from "./harness.ts";
import { nanocodeModule } from "./module.ts";
import type { ModelProvider } from "../index.ts";

export type Selection = { provider: ModelProvider; model: string; thinking: Thinking; max_tokens?: number; service_tier?: ServiceTier };

export type SelectionModel = { id: string; label: string; name: string; efforts: Thinking[]; effort: Thinking; maxTokens?: number; serviceTier?: ServiceTier };

export type SelectionHarness = { id: ModelProvider; label: string; models: SelectionModel[] };

export type Authorize = ((request: Request) => Promise<void> | void) | "public";

export type NanocodeAppOptions = Omit<NanocodeHarnessOptions, "provider" | "model" | "thinking" | "tools" | "durability"> & {
  harnesses: SelectionHarness[];
  defaultSelection?: Selection;
  tools?: HostTool[];
  authorize?: Authorize;
  durability?: "on" | "strict";
  runAhead?: boolean;
  maxPromptCharacters?: number;
  chaos?: boolean;
  marks?: boolean;
  traceAudience?: string;
  directDriveMs?: number;
  deadlineMarginMs?: number;
};

export function selectionOf(harnesses: SelectionHarness[], harness: unknown, chosen: unknown, effort: unknown): Selection | undefined {
  const entry = harnesses.find(candidate => candidate.id === harness);
  const found = entry?.models.find(candidate => candidate.id === chosen);
  if (!entry || !found) return undefined;
  const thinking = effort === undefined ? found.effort : found.efforts.includes(effort as Thinking) ? effort as Thinking : undefined;
  if (!thinking) return undefined;
  return { model: found.id, provider: entry.id, thinking, ...(found.maxTokens ? { max_tokens: found.maxTokens } : {}), ...(found.serviceTier ? { service_tier: found.serviceTier } : {}) };
}

type Body = { effort?: unknown; hand?: unknown; harness?: unknown; model?: unknown; sessionId?: unknown; text?: unknown; warm?: unknown };

export function createNanocode(options: NanocodeAppOptions) {
  const { harnesses, authorize, maxPromptCharacters, chaos, marks, traceAudience, runAhead, directDriveMs, deadlineMarginMs, defaultSelection: chosenDefault, hands: chosenHands, ...rest } = options;
  const hands = chosenHands ?? {};
  const harness = { ...rest, hands };
  const first = harnesses[0]!.models[0]!;
  const defaultSelection = chosenDefault ?? { provider: harnesses[0]!.id, model: first.id, thinking: first.efforts.includes("low") ? "low" : first.effort };
  const durability = options.durability ?? "on";
  const kernel = durability === "on" && runAhead === true ? "on" : "strict";
  const agent = durableAgent({
    harness: nanocodeHarness({
      codeMode: true,
      subagents: true,
      streamToolInput: true,
      ...harness,
      provider: defaultSelection.provider,
      model: defaultSelection.model,
      thinking: defaultSelection.thinking,
      durability,
    }),
    durability: kernel,
    marks: marks ?? false,
    ...(directDriveMs ? { directDriveMs } : {}),
    ...(deadlineMarginMs ? { deadlineMarginMs } : {}),
  });
  const chat = agent.chatRoute(authorize ? { authorize } : {});
  const handRoutes = handRoute({
    world: getWorld,
    owns: async (sessionId, channel) => ((await agent.sessions.inspect(sessionId)).config as { hand?: unknown } | undefined)?.hand === channel,
    ...(hands && hands.holdMs ? { holdMs: hands.holdMs } : {}),
  });
  const streamsHands = hands !== false && !hands.relay;

  const admit = async (request: Request): Promise<Response | undefined> => {
    if (typeof authorize === "function") {
      try {
        await authorize(request);
      } catch (refusal) {
        if (refusal instanceof Response) return refusal;
        throw refusal;
      }
      return undefined;
    }
    if (authorize !== "public" && process.env.NODE_ENV === "production") return new Response("set an authorize function or authorize: \"public\" to start sessions in production", { status: 401 });
    return undefined;
  };

  const start = async (request: Request, body: Body): Promise<string | Response> => {
    const selection = body.harness === undefined && body.model === undefined ? defaultSelection : selectionOf(harnesses, body.harness, body.model, body.effort);
    if (!selection) return new Response(`harness, model and effort must name one of ${harnesses.map(entry => `${entry.id} (${entry.models.map(model => `${model.id}: ${model.efforts.join("|")}`).join(", ")})`).join(" or ")}`, { status: 400 });
    const refused = await admit(request);
    if (refused) return refused;
    const hand = harness.hands && typeof body.hand === "string" && HAND_CHANNEL.test(body.hand) ? { hand: body.hand } : {};
    const config = { ...hand, durability: kernel === "on" ? "run-ahead" : "strict", nanocode: selection satisfies Omit<NanocodeSession, "session_id">, traceAudience: traceAudience ?? (authorize === "public" ? "public" : "unknown") };
    const { sessionId } = await agent.sessions.start({ config });
    return sessionId;
  };

  async function GET(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;
    if (streamsHands && params.has("hand")) return handRoutes.GET(request);
    if (!params.has("keepwarm")) return chat.GET(request);
    await nanocodeModule();
    return new Response(null, { status: 204 });
  }

  async function POST(request: Request): Promise<Response> {
    if (streamsHands && new URL(request.url).searchParams.has("hand")) return handRoutes.POST(request);
    const body = await request.clone().json().catch(() => undefined) as Body | undefined;
    if (!body || typeof body !== "object") return chat.POST(request);
    if (maxPromptCharacters && typeof body.text === "string" && body.text.length > maxPromptCharacters) return new Response(`A prompt is at most ${maxPromptCharacters} characters.`, { status: 413 });
    if (typeof body.sessionId === "string") return chat.POST(request);
    if (body.warm === true) {
      const sessionId = await start(request, body);
      if (sessionId instanceof Response) return sessionId;
      void nanocodeModule();
      return Response.json({ sessionId });
    }
    if (body.sessionId !== undefined || typeof body.text !== "string" || !body.text) return chat.POST(request);
    const sessionId = await start(request, body);
    if (sessionId instanceof Response) return sessionId;
    return chat.POST(new Request(request.url, { body: JSON.stringify({ ...body, sessionId }), headers: request.headers, method: "POST", signal: request.signal }));
  }

  async function crash(request: Request): Promise<Response> {
    if (!chaos) return new Response("chaos is off for this deployment", { status: 404 });
    const refused = await admit(request);
    if (refused) return refused;
    const { sessionId, at = "tool", afterMs = 500 } = await request.json() as { sessionId?: string; at?: "tool" | "any"; afterMs?: number };
    if (!sessionId) return new Response("sessionId is required", { status: 400 });
    const id = await agent.sessions.chaos(sessionId, { at, afterMs });
    return Response.json({ armed: id, at, afterMs });
  }

  return { agent, GET, POST, chaos: { POST: crash }, defaultSelection, harnesses };
}
