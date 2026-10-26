import { DurableObject } from "cloudflare:workers";
import { pythonServer } from "../bash/commands/pyserver.ts";
import type { PythonReply, PythonRequest } from "../bash/commands/python.ts";
import { loadWorkersPyodide } from "./pyodide.ts";

export class Python<Env = unknown> extends DurableObject<Env> {
  readonly #serve = pythonServer(loadWorkersPyodide, { load: () => this.ctx.storage.get<string[][]>("pip"), save: installs => this.ctx.storage.put("pip", installs) });

  run(request: PythonRequest): Promise<PythonReply> {
    return this.#serve(request);
  }
}

