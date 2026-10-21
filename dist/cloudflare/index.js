export const SQLITE_VALUE_LIMIT_BYTES = 8_388_608;
export class DurableObjectSql {
    value_limit = SQLITE_VALUE_LIMIT_BYTES;
    storage;
    observe;
    constructor(storage, observe) {
        this.storage = storage;
        this.observe = observe;
    }
    transaction(kind, operation, statements) {
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
        }
        finally {
            this.observe?.({ kind, operation, statements: statements.length, rows_read, rows_written, duration_ms: performance.now() - started });
        }
    }
}
