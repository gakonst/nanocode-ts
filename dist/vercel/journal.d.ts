import { type DriveContext, type SessionState } from "durable-harness";
import type { SqlHost, SqlKind, SqlValue, Statement } from "../index.ts";
export declare const SQL_STEP = "nanocode.sql";
export type Transaction = {
    kind: SqlKind;
    operation: string;
    statements: Statement[];
};
export type Durability = "on" | "strict";
export type JournalStats = {
    replayed_batches: number;
    replayed_transactions: number;
    batches: number;
    transactions: number;
    reads: number;
    batch_wait_ms: number;
};
export declare const batchKey: (n: number) => string;
export declare function committedBatches(state: SessionState): Transaction[][];
export declare class LocalSql {
    private readonly db;
    private readonly statements;
    constructor(batches: Transaction[][]);
    run(statements: Statement[]): SqlValue[][][];
    version(): string;
    close(): void;
    private prepare;
}
export declare class SqlJournal implements SqlHost {
    private readonly ctx;
    private readonly durability;
    private readonly sql;
    private readonly writer;
    private queue;
    private flushing;
    private failure?;
    private committed;
    readonly stats: JournalStats;
    constructor(ctx: DriveContext, durability: Durability);
    get batches(): number;
    transaction(kind: SqlKind, operation: string, statements: Statement[]): Promise<SqlValue[][][]>;
    durable(): Promise<void>;
    close(): void;
    private enqueue;
    private flush;
    private commit;
}
