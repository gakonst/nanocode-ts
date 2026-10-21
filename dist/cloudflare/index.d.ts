import type { SqlHost, SqlKind, SqlValue, Statement } from "../index.ts";
export type SqlCursor = {
    raw(): IterableIterator<SqlValue[]>;
    readonly rowsRead: number;
    readonly rowsWritten: number;
};
export type DurableObjectSqlStorage = {
    readonly sql: {
        exec(query: string, ...bindings: SqlValue[]): SqlCursor;
    };
    transactionSync<T>(closure: () => T): T;
};
export declare const SQLITE_VALUE_LIMIT_BYTES = 8388608;
export type SqlObservation = {
    kind: SqlKind;
    operation: string;
    statements: number;
    rows_read: number;
    rows_written: number;
    duration_ms: number;
};
export declare class DurableObjectSql implements SqlHost {
    readonly value_limit = 8388608;
    readonly storage: DurableObjectSqlStorage;
    private readonly observe?;
    constructor(storage: DurableObjectSqlStorage, observe?: (observation: SqlObservation) => void);
    transaction(kind: SqlKind, operation: string, statements: Statement[]): SqlValue[][][];
}
