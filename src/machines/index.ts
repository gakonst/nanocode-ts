import { createConfig, type Entry, liveEvent, type Transport } from "../client.ts";
import * as Cloud from "./cloud.ts";
import type * as Local from "./local.ts";
import * as Mcp from "./mcp.ts";
import * as Models from "./models.ts";
import * as Payment from "./payment.ts";
import * as Payments from "./payments.ts";
import * as Wallet from "./wallet.ts";

export { Cloud, Mcp, Models, Payment, Payments, Wallet };

export type { Local };

export const commands = [
  { detail: "connect Tempo Wallet and approve a key that pays for this agent", label: "/login" },
  { detail: "show your MACH and what the key may still spend", label: "/wallet" },
  { detail: "buy MACH in Tempo Wallet", label: "/fund" },
  { detail: "run the agent in the cloud: turns keep going after you close the tab", label: "/cloud" },
  { detail: "run the agent in this tab again", label: "/local" },
  { detail: "clear the conversation and start a new session", label: "/clear" },
  { detail: "revoke the key in Tempo Wallet and forget it here", label: "/logout" },
  { detail: "list the commands", label: "/help" },
] as const;

export const localKey = "nanocode.machines.local";

export const limits = `at most ${amount(Wallet.allowance)} MACH, plus ${amount(Wallet.feeAllowance)} ${Wallet.usdc.symbol} for fees, until it expires a day later`;

export type Options = {
  history: string;
  instructions: string;
  model: () => Models.Model;
  archive?: Local.Options["archive"];
  codeMode?: boolean;
  inference?: Models.Inference;
  payment?: Payment.Config;
  suggestion?: string;
  sqlite: Local.Options["sqlite"];
  wasm: Local.Options["wasm"];
};

export type Runtime = { agent?: Local.Agent; cloud?: Cloud.Cloud; model: () => Models.Model; options: Options; payment: Payment.Payment };

export function createMachine(options: Options) {
  const payment = Payment.resolve(options.payment);
  if (payment.inference === "apiKey" && !options.inference) throw new Error("payment.inference apiKey needs options.inference");
  const runtime: Runtime = { cloud: payment.inference === "tempo" ? Cloud.restore() : undefined, model: options.model, options, payment };
  const resume: Transport["resume"] = async ({ push, note, signal }) => {
    if (runtime.cloud?.open) await Cloud.resume(runtime.cloud, handlers(push, note), signal);
  };
  const config = createConfig({
    history: { key: options.history },
    keep: 300,
    revealMs: 0,
    transport: {
      async send({ prompt, push, note, signal }) {
        if (runtime.cloud) return Cloud.ask(runtime.cloud, prompt, handlers(push, note), runtime.model(), signal);
        if (!runtime.agent) throw new Error("The agent is still loading.");
        if (!(await runtime.agent.ask(prompt))) throw new Error("The turn has no result.");
      },
      async steer({ prompt, note }) {
        if (runtime.cloud) {
          if (await Cloud.steer(runtime.cloud, prompt, runtime.model()) === "steered") return true;
          note("tool", "The turn is finishing; ask again in a moment.");
          return false;
        }
        return await runtime.agent?.steer(prompt) === "steered";
      },
      get resume() {
        return runtime.cloud ? resume : undefined;
      },
      restore(saved) {
        if (runtime.cloud) Cloud.adopt(runtime.cloud, saved);
      },
      snapshot: () => runtime.cloud && Cloud.snapshot(runtime.cloud),
    },
  });
  return { config, runtime };
}

function handlers(push: (event: NonNullable<ReturnType<typeof liveEvent>>) => void, note: (kind: Entry["kind"], text: string) => void): Cloud.Handlers {
  return {
    event: logged => {
      const event = liveEvent(logged);
      if (event) push(event);
    },
    interrupted: () => note("tool", "The session's Durable Object reset. Its alarm started it again, and the turn continues from its checkpoint."),
  };
}

export function until(wallet: Wallet.Wallet) {
  return new Date(wallet.expiry * 1000).toLocaleString(undefined, { day: "numeric", hour: "numeric", minute: "2-digit", month: "short" });
}

export function amount(atomics: bigint) {
  return Wallet.format(atomics).replace(/\.?0+$/, "");
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
