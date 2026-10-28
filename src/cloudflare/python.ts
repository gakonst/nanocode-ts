/**
 * Cloudflare Python entrypoint: the `Python` Durable Object, which runs the Python of a workspace
 * in Pyodide and keeps pip installs in its storage.
 *
 * @module
 */
import { DurableObject } from 'cloudflare:workers'
import type { Reply as PythonReply, Request as PythonRequest } from '../bash/Python.ts'
import { pythonServer } from '../bash/internal/commands/pyserver.ts'
import * as Pyodide from './internal/Pyodide.ts'

let parts: Pyodide.SnapshotParts | undefined

const serve = pythonServer(() => Pyodide.load({ parts }))

/**
 * Durable Object that runs Python requests. The `PYODIDE_SNAPSHOT` binding, when present, serves
 * the snapshot parts.
 */
export class Python<Env = unknown> extends DurableObject<Env> {
  /** Runs one Python request. */
  run(request: PythonRequest): Promise<PythonReply> {
    const assets = (this.env as { PYODIDE_SNAPSHOT?: Fetcher }).PYODIDE_SNAPSHOT
    if (assets) parts ??= (name) => assets.fetch('https://snapshot/' + name)
    return serve(request, {
      load: () => this.ctx.storage.get<string[][]>('pip'),
      save: (installs) => this.ctx.storage.put('pip', installs),
    })
  }
}
