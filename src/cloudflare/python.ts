import { DurableObject } from "cloudflare:workers";
import { pythonServer } from "../bash/commands/pyserver.ts";
import type { PythonReply, PythonRequest } from "../bash/commands/python.ts";
import { loadWorkersPyodide } from "./pyodide.ts";

const serve = pythonServer(loadWorkersPyodide);

export class Python<Env = unknown> extends DurableObject<Env> {
  run(request: PythonRequest): Promise<PythonReply> {
    return serve(request, { load: () => this.ctx.storage.get<string[][]>("pip"), save: installs => this.ctx.storage.put("pip", installs) });
  }
}

