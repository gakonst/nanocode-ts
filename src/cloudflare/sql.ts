import type { SqlHost, SqlKind, SqlValue, Statement } from "../index.ts";

export type SqlCursor = { raw(): IterableIterator<SqlValue[]>; readonly rowsRead: number; readonly rowsWritten: number };

export type DurableObjectSqlStorage = {
  readonly sql: { exec(query: string, ...bindings: SqlValue[]): SqlCursor };
  transactionSync<T>(closure: () => T): T;
};

export const SQLITE_VALUE_LIMIT_BYTES = 8_388_608;

export type SqlObservation = { kind: SqlKind; operation: string; statements: number; rows_read: number; rows_written: number; duration_ms: number };

export class DurableObjectSql implements SqlHost {
  readonly value_limit: number;
  readonly storage: DurableObjectSqlStorage;
  private readonly observe?: (observation: SqlObservation) => void;

  constructor(storage: DurableObjectSqlStorage, observe?: (observation: SqlObservation) => void, valueLimit: number = SQLITE_VALUE_LIMIT_BYTES) {
    if (!Number.isSafeInteger(valueLimit) || valueLimit <= 0) throw new Error("the SQL value limit must be a positive integer");
    this.storage = storage;
    this.value_limit = valueLimit;
    this.observe = observe;
  }

  transaction(kind: SqlKind, operation: string, statements: Statement[]): SqlValue[][][] {
    for (const [query, ...values] of statements) {
      for (const value of values) {
        const bytes = typeof value === "string" ? (value.length * 3 <= this.value_limit ? 0 : new TextEncoder().encode(value).length) : value instanceof ArrayBuffer ? value.byteLength : 0;
        if (bytes > this.value_limit) throw new Error(`a bound value of ${bytes} bytes exceeds the host's ${this.value_limit}-byte SQL value limit: ${query.slice(0, 80)}`);
      }
    }
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

export class DurableObjectBlobs {
  private readonly storage: DurableObjectSqlStorage;
  private readonly partBytes: number;

  constructor(storage: DurableObjectSqlStorage, partBytes: number = SQLITE_VALUE_LIMIT_BYTES) {
    this.storage = storage;
    this.partBytes = partBytes;
    storage.sql.exec("CREATE TABLE IF NOT EXISTS blobs (key TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (key, part)) WITHOUT ROWID");
  }

  put(key: string, bytes: Uint8Array): void {
    this.storage.transactionSync(() => {
      if ([...this.storage.sql.exec("SELECT 1 FROM blobs WHERE key = ? LIMIT 1", key).raw()].length) return;
      for (let offset = 0, part = 0; offset < bytes.length || part === 0; offset += this.partBytes, part++) {
        this.storage.sql.exec("INSERT INTO blobs (key, part, bytes) VALUES (?, ?, ?)", key, part, bytes.slice(offset, offset + this.partBytes).buffer);
      }
    });
  }

  get(key: string): Uint8Array | null {
    const parts = [...this.storage.sql.exec("SELECT bytes FROM blobs WHERE key = ? ORDER BY part", key).raw()].map(([bytes]) => new Uint8Array(bytes as ArrayBuffer));
    if (!parts.length) return null;
    const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) { joined.set(part, offset); offset += part.length; }
    return joined;
  }
}
