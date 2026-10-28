/**
 * Read-only view of a session's turns and event log, rebuilt from the journal's committed batches.
 *
 * @module
 */
import type { SessionState } from 'durable-harness'
import * as AgentRuntime from '../AgentRuntime.ts'
import type * as Contracts from '../Contracts.ts'
import * as Harness from './Harness.ts'
import * as LocalSql from './internal/LocalSql.ts'
import * as Journal from './Journal.ts'
import * as Wasm from './Wasm.ts'

/** Read-only runtime over a replica of a session's SQL log. */
export type Reader = {
  /** Disposes the runtime and closes the replica. */
  close(): Promise<void>
  /** Returns a page of logged events after `after`, for one turn when `request_id` is set. */
  page(after: number, limit: number, request_id?: string): Promise<Contracts.LogPage>
  /** Returns one turn, or `null` when the session has no such turn. */
  turn(request_id: string): Promise<Contracts.TurnView | null>
}

/** Replays the committed SQL batches of a session into a local replica and opens a runtime over it. */
export async function open(state: SessionState, options: open.Options = {}): Promise<Reader> {
  const module = options.module ?? Wasm.load
  const sql = LocalSql.create(Journal.committed(state))
  const runtime = await AgentRuntime.instantiate(
    await module(),
    { transaction: (_kind, _operation, statements) => sql.run(statements) },
    { published: () => undefined },
  )

  return {
    async close() {
      await runtime.dispose()
      sql.close()
    },
    page: (after, limit, request_id) => runtime.page(Harness.scope, after, limit, request_id),
    turn: (request_id) => runtime.turn(Harness.scope, request_id),
  }
}

export declare namespace open {
  type Options = {
    /** Loads the WebAssembly module. Defaults to `Wasm.load`. */
    module?: (() => Promise<WebAssembly.Module>) | undefined
  }
}
