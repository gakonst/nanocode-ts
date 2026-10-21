import { AgentRuntime } from "../index.js";
import { SCOPE } from "./harness.js";
import { committedBatches, LocalSql } from "./journal.js";
import { nanocodeModule } from "./module.js";
export async function openReader(state, module = nanocodeModule) {
    const sql = new LocalSql(committedBatches(state));
    const runtime = await AgentRuntime.instantiate(await module(), { transaction: (_kind, _operation, statements) => sql.run(statements) }, { published: () => undefined });
    return {
        turn: request_id => runtime.turn(SCOPE, request_id),
        page: (after, limit, request_id) => runtime.page(SCOPE, after, limit, request_id),
        async close() {
            await runtime.dispose();
            sql.close();
        },
    };
}
