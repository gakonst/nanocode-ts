import { DatabaseSync, type StatementSync } from "node:sqlite";
import { type DriveContext, Fatal, Restart, type SessionState } from "durable-harness";
import type { SqlHost, SqlKind, SqlValue, Statement } from "../index.ts";

export const SQL_STEP = "nanocode.sql";

export type Transaction = { kind: SqlKind; operation: string; statements: Statement[] };

type Batch = { transactions: Transaction[] };

type Committed = { writer: string };

type Entry = { transaction?: Transaction; resolve(): void; reject(error: unknown): void };

export type Durability = "on" | "strict";

export type JournalStats = { replayed_batches: number; replayed_transactions: number; batches: number; transactions: number; reads: number; batch_wait_ms: number };

export const batchKey = (n: number) => `sql:${n}`;

export function committedBatches(state: SessionState): Transaction[][] {
  const batches: Transaction[][] = [];
  for (let record = state.effects.get(batchKey(0)); record?.status === "completed"; record = state.effects.get(batchKey(batches.length))) {
    batches.push((record.input as Batch).transactions);
  }
  return batches;
}

export class LocalSql {
  private readonly db = new DatabaseSync(":memory:");
  private readonly statements = new Map<string, StatementSync>();

  constructor(batches: Transaction[][]) {
    batches.forEach((transactions, n) => {
      for (const { statements } of transactions) {
        try { this.run(statements); }
        catch (error) { throw new Fatal(`nanocode: SQL batch ${n} of the session's log does not replay: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
  }

  run(statements: Statement[]): SqlValue[][][] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = statements.map(([query, ...values]) => this.prepare(query).all(...(values as (string | null)[])) as unknown as SqlValue[][]);
      this.db.exec("COMMIT");
      return rows;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  version(): string {
    const [changes, schema] = this.prepare("SELECT total_changes(), schema_version FROM pragma_schema_version").get() as unknown as [number, number];
    return `${changes}:${schema}`;
  }

  close(): void {
    this.db.close();
  }

  private prepare(query: string): StatementSync {
    let statement = this.statements.get(query);
    if (!statement) {
      statement = this.db.prepare(query);
      statement.setReturnArrays(true);
      this.statements.set(query, statement);
    }
    return statement;
  }
}

export class SqlJournal implements SqlHost {
  private readonly ctx: DriveContext;
  private readonly durability: Durability;
  private readonly sql: LocalSql;
  private readonly writer = crypto.randomUUID();
  private queue: Entry[] = [];
  private flushing = false;
  private failure?: { error: unknown };
  private committed: number;
  readonly stats: JournalStats;

  constructor(ctx: DriveContext, durability: Durability) {
    this.ctx = ctx;
    this.durability = durability;
    const batches = committedBatches(ctx.state());
    this.sql = new LocalSql(batches);
    this.committed = batches.length;
    this.stats = { replayed_batches: batches.length, replayed_transactions: batches.reduce((count, batch) => count + batch.length, 0), batches: 0, transactions: 0, reads: 0, batch_wait_ms: 0 };
  }

  get batches(): number {
    return this.committed;
  }

  transaction(kind: SqlKind, operation: string, statements: Statement[]): Promise<SqlValue[][][]> {
    if (this.failure) return Promise.reject(this.failure.error);
    let rows: SqlValue[][][];
    let wrote: boolean;
    try {
      const before = this.sql.version();
      rows = this.sql.run(statements);
      wrote = this.sql.version() !== before;
    } catch (error) {
      return Promise.reject(error);
    }
    if (wrote) this.stats.transactions++;
    else this.stats.reads++;
    const durable = this.enqueue(wrote ? { kind, operation, statements } : undefined);
    if (this.durability === "strict") return durable.then(() => rows);
    durable.catch(() => undefined);
    return Promise.resolve(rows);
  }

  durable(): Promise<void> {
    return this.enqueue(undefined);
  }

  close(): void {
    this.sql.close();
  }

  private enqueue(transaction: Transaction | undefined): Promise<void> {
    if (this.failure) return Promise.reject(this.failure.error);
    if (!transaction && !this.flushing && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.queue.push({ transaction, resolve, reject });
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        await new Promise(resolve => setImmediate(resolve));
        const entries = this.queue.splice(0);
        const transactions = entries.flatMap(entry => entry.transaction ? [entry.transaction] : []);
        try {
          if (transactions.length) await this.commit(transactions);
        } catch (error) {
          this.failure = { error };
          for (const entry of [...entries, ...this.queue.splice(0)]) entry.reject(error);
          this.ctx.halt?.(error);
          return;
        }
        for (const entry of entries) entry.resolve();
      }
    } finally {
      this.flushing = false;
    }
  }

  private async commit(transactions: Transaction[]): Promise<void> {
    const n = this.committed;
    const started = performance.now();
    const output = await this.ctx.effect(batchKey(n), { name: SQL_STEP, replay: "safe", input: { transactions } satisfies Batch }, async (): Promise<Committed> => ({ writer: this.writer }));
    this.stats.batch_wait_ms += performance.now() - started;
    if (output.writer !== this.writer) throw new Restart(`SQL batch ${n} was committed by another drive`);
    this.committed = n + 1;
    this.stats.batches++;
  }
}
