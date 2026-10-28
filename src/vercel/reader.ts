import type { SessionState } from 'durable-harness'
import { AgentRuntime, type LogPage, type TurnView } from '../index.ts'
import { SCOPE } from './harness.ts'
import { committedBatches, LocalSql } from './journal.ts'
import { nanocodeModule } from './module.ts'

export type NanocodeReader = {
  turn(request_id: string): Promise<TurnView | null>
  page(after: number, limit: number, request_id?: string): Promise<LogPage>
  close(): Promise<void>
}

export async function openReader(
  state: SessionState,
  module: () => Promise<WebAssembly.Module> = nanocodeModule,
): Promise<NanocodeReader> {
  const sql = new LocalSql(committedBatches(state))
  const runtime = await AgentRuntime.instantiate(
    await module(),
    { transaction: (_kind, _operation, statements) => sql.run(statements) },
    { published: () => undefined },
  )
  return {
    turn: (request_id) => runtime.turn(SCOPE, request_id),
    page: (after, limit, request_id) => runtime.page(SCOPE, after, limit, request_id),
    async close() {
      await runtime.dispose()
      sql.close()
    },
  }
}
