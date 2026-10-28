import type { SessionState } from 'durable-harness'
import * as AgentRuntime from '../AgentRuntime.ts'
import type * as Contracts from '../Contracts.ts'
import * as Harness from './Harness.ts'
import * as LocalSql from './internal/LocalSql.ts'
import * as Journal from './Journal.ts'
import * as Wasm from './Wasm.ts'

export type Reader = {
  close(): Promise<void>
  page(after: number, limit: number, request_id?: string): Promise<Contracts.LogPage>
  turn(request_id: string): Promise<Contracts.TurnView | null>
}

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
    module?: (() => Promise<WebAssembly.Module>) | undefined
  }
}
