import { DurableObject } from 'cloudflare:workers'
import type { Reply as PythonReply, Request as PythonRequest } from '../bash/Python.ts'
import { pythonServer, type PythonFiles } from '../bash/internal/commands/pyserver.ts'
import * as Sql from './Sql.ts'
import * as Pyodide from './internal/Pyodide.ts'

let parts: Pyodide.SnapshotParts | undefined

const serve = pythonServer(() => Pyodide.load({ parts }))

export class Python<Env = unknown> extends DurableObject<Env> {
  run(request: PythonRequest): Promise<PythonReply> {
    const assets = (this.env as { PYODIDE_SNAPSHOT?: Fetcher }).PYODIDE_SNAPSHOT
    if (assets) parts ??= (name) => assets.fetch('https://snapshot/' + name)
    return serve(request, {
      files: this.files(),
      load: () => this.ctx.storage.get<string[][]>('pip'),
      save: (installs) => this.ctx.storage.put('pip', installs),
    })
  }

  private files(): PythonFiles {
    const sql = this.ctx.storage.sql
    sql.exec(
      'CREATE TABLE IF NOT EXISTS mirrored (key TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, part)) WITHOUT ROWID',
    )
    return {
      clear: () => void sql.exec('DELETE FROM mirrored'),
      get: (key) => {
        const parts = [
          ...sql.exec<{ data: ArrayBuffer }>(
            'SELECT data FROM mirrored WHERE key = ? ORDER BY part',
            key,
          ),
        ].map((row) => new Uint8Array(row.data))
        const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
        let offset = 0
        for (const part of parts) {
          out.set(part, offset)
          offset += part.length
        }
        return out
      },
      put: (key, data) => {
        for (
          let offset = 0, part = 0;
          offset < data.length || part === 0;
          offset += Sql.valueLimitBytes, part++
        )
          sql.exec(
            'INSERT OR REPLACE INTO mirrored (key, part, data) VALUES (?, ?, ?)',
            key,
            part,
            data.slice(offset, offset + Sql.valueLimitBytes).buffer,
          )
      },
    }
  }
}
