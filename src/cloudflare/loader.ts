import { CELL_GLOBALS, CELL_SCOPE } from "../cell.ts";
import type { CellEvaluator } from "../hand.ts";

export type WorkerCode = { compatibilityDate: string; compatibilityFlags?: string[]; mainModule: string; modules: Record<string, string>; globalOutbound?: unknown; env?: Record<string, unknown> };

export type WorkerLoader = { get(id: string, code: () => WorkerCode | Promise<WorkerCode>): { getEntrypoint(name?: string): unknown } };

export type WorkerLoaderOptions = { compatibilityDate?: string; compatibilityFlags?: string[] };

export function workerLoader(loader: WorkerLoader, options: WorkerLoaderOptions = {}): CellEvaluator {
  let next = 0;
  return async (code, host, definitions, stored) => {
    const { setTimeout: _set, clearTimeout: _clear, ...remote } = host;
    const source = "import { WorkerEntrypoint } from \"cloudflare:workers\";\nconst scope = " + CELL_SCOPE + ";\nexport default class extends WorkerEntrypoint {\n  run(host, definitions, stored) {\n    return scope(host, definitions, stored).run(() => async function (" + CELL_GLOBALS.join(", ") + ") {\n" + code + "\n});\n  }\n}\n";
    const id = "nanocode-cell-" + Date.now().toString(36) + "-" + (next++).toString(36) + "-" + Math.random().toString(36).slice(2);
    const worker = loader.get(id, () => ({
      compatibilityDate: options.compatibilityDate ?? "2026-10-01",
      compatibilityFlags: options.compatibilityFlags ?? [],
      mainModule: "cell.js",
      modules: { "cell.js": source },
      globalOutbound: null,
    }));
    const entrypoint = worker.getEntrypoint() as { run(host: unknown, definitions: unknown, stored: unknown): Promise<{ error?: string; stored: Record<string, unknown> }> };
    try {
      return await entrypoint.run(remote, definitions, stored);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), stored: {} };
    }
  };
}
