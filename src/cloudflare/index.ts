import type { SqlHost, SqlKind, SqlValue, Statement } from "../index.ts";

export type SqlCursor = { raw(): IterableIterator<SqlValue[]>; readonly rowsRead: number; readonly rowsWritten: number };

export type DurableObjectSqlStorage = {
  readonly sql: { exec(query: string, ...bindings: SqlValue[]): SqlCursor };
  transactionSync<T>(closure: () => T): T;
};

export const SQLITE_VALUE_LIMIT_BYTES = 8_388_608;

export type SqlObservation = { kind: SqlKind; operation: string; statements: number; rows_read: number; rows_written: number; duration_ms: number };

export class DurableObjectSql implements SqlHost {
  readonly value_limit = SQLITE_VALUE_LIMIT_BYTES;
  readonly storage: DurableObjectSqlStorage;
  private readonly observe?: (observation: SqlObservation) => void;

  constructor(storage: DurableObjectSqlStorage, observe?: (observation: SqlObservation) => void) {
    this.storage = storage;
    this.observe = observe;
  }

  transaction(kind: SqlKind, operation: string, statements: Statement[]): SqlValue[][][] {
    const started = performance.now();
    let rows_read = 0;
    let rows_written = 0;
    try {
      return this.storage.transactionSync(() => statements.map(([query, ...values]) => {
        const cursor = this.storage.sql.exec(query, ...values);
        const rows = [...cursor.raw()];
        rows_read += cursor.rowsRead;
        rows_written += cursor.rowsWritten;
        return rows;
      }));
    } finally {
      this.observe?.({ kind, operation, statements: statements.length, rows_read, rows_written, duration_ms: performance.now() - started });
    }
  }
}
export { workerLoader, type WorkerCode, type WorkerLoader, type WorkerLoaderOptions } from "./loader.ts";
