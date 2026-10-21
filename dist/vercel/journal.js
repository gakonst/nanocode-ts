import { DatabaseSync } from "node:sqlite";
import { Fatal, Restart } from "durable-harness";
export const SQL_STEP = "nanocode.sql";
export const batchKey = (n) => `sql:${n}`;
export function committedBatches(state) {
    const batches = [];
    for (let record = state.effects.get(batchKey(0)); record?.status === "completed"; record = state.effects.get(batchKey(batches.length))) {
        batches.push(record.input.transactions);
    }
    return batches;
}
export class LocalSql {
    db = new DatabaseSync(":memory:");
    statements = new Map();
    constructor(batches) {
        batches.forEach((transactions, n) => {
            for (const { statements } of transactions) {
                try {
                    this.run(statements);
                }
                catch (error) {
                    throw new Fatal(`nanocode: SQL batch ${n} of the session's log does not replay: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        });
    }
    run(statements) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const rows = statements.map(([query, ...values]) => this.prepare(query).all(...values));
            this.db.exec("COMMIT");
            return rows;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    version() {
        const [changes, schema] = this.prepare("SELECT total_changes(), schema_version FROM pragma_schema_version").get();
        return `${changes}:${schema}`;
    }
    close() {
        this.db.close();
    }
    prepare(query) {
        let statement = this.statements.get(query);
        if (!statement) {
            statement = this.db.prepare(query);
            statement.setReturnArrays(true);
            this.statements.set(query, statement);
        }
        return statement;
    }
}
export class SqlJournal {
    ctx;
    durability;
    sql;
    writer = crypto.randomUUID();
    queue = [];
    flushing = false;
    failure;
    committed;
    stats;
    constructor(ctx, durability) {
        this.ctx = ctx;
        this.durability = durability;
        const batches = committedBatches(ctx.state());
        this.sql = new LocalSql(batches);
        this.committed = batches.length;
        this.stats = { replayed_batches: batches.length, replayed_transactions: batches.reduce((count, batch) => count + batch.length, 0), batches: 0, transactions: 0, reads: 0, batch_wait_ms: 0 };
    }
    get batches() {
        return this.committed;
    }
    transaction(kind, operation, statements) {
        if (this.failure)
            return Promise.reject(this.failure.error);
        let rows;
        let wrote;
        try {
            const before = this.sql.version();
            rows = this.sql.run(statements);
            wrote = this.sql.version() !== before;
        }
        catch (error) {
            return Promise.reject(error);
        }
        if (wrote)
            this.stats.transactions++;
        else
            this.stats.reads++;
        const durable = this.enqueue(wrote ? { kind, operation, statements } : undefined);
        if (this.durability === "strict")
            return durable.then(() => rows);
        durable.catch(() => undefined);
        return Promise.resolve(rows);
    }
    durable() {
        return this.enqueue(undefined);
    }
    close() {
        this.sql.close();
    }
    enqueue(transaction) {
        if (this.failure)
            return Promise.reject(this.failure.error);
        if (!transaction && !this.flushing && this.queue.length === 0)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            this.queue.push({ transaction, resolve, reject });
            void this.flush();
        });
    }
    async flush() {
        if (this.flushing)
            return;
        this.flushing = true;
        try {
            while (this.queue.length) {
                await new Promise(resolve => setImmediate(resolve));
                const entries = this.queue.splice(0);
                const transactions = entries.flatMap(entry => entry.transaction ? [entry.transaction] : []);
                try {
                    if (transactions.length)
                        await this.commit(transactions);
                }
                catch (error) {
                    this.failure = { error };
                    for (const entry of [...entries, ...this.queue.splice(0)])
                        entry.reject(error);
                    this.ctx.halt?.(error);
                    return;
                }
                for (const entry of entries)
                    entry.resolve();
            }
        }
        finally {
            this.flushing = false;
        }
    }
    async commit(transactions) {
        const n = this.committed;
        const started = performance.now();
        const output = await this.ctx.effect(batchKey(n), { name: SQL_STEP, replay: "safe", input: { transactions } }, async () => ({ writer: this.writer }));
        this.stats.batch_wait_ms += performance.now() - started;
        if (output.writer !== this.writer)
            throw new Restart(`SQL batch ${n} was committed by another drive`);
        this.committed = n + 1;
        this.stats.batches++;
    }
}
