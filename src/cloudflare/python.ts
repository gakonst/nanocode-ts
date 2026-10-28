import { DurableObject } from "cloudflare:workers";
import { pythonServer } from "../bash/commands/pyserver.ts";
import type { PythonReply, PythonRequest } from "../bash/commands/python.ts";
import { loadWorkersPyodide, type SnapshotParts } from "./pyodide.ts";

let parts: SnapshotParts | undefined;

const serve = pythonServer(() => loadWorkersPyodide(parts));

export class Python<Env = unknown> extends DurableObject<Env> {
  run(request: PythonRequest): Promise<PythonReply> {
    const assets = (this.env as { PYODIDE_SNAPSHOT?: Fetcher }).PYODIDE_SNAPSHOT;
    if (assets) parts ??= name => assets.fetch("https://snapshot/" + name);
    return serve(request, { load: () => this.ctx.storage.get<string[][]>("pip"), save: installs => this.ctx.storage.put("pip", installs) });
  }
}
