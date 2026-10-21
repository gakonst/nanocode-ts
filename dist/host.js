import { HostFailure, RECENT_MODEL_LIMIT, RemoteRefusal, sessionUuid } from "./contracts.js";
import { Timings } from "./timing.js";
const NULL_CELL = 0xffffffff;
export class AgentRuntime {
    runtimeId = sessionUuid();
    startedAt = Date.now();
    started = performance.now();
    timings = new Timings();
    checkpointTimings = new Timings();
    models = [];
    wasm;
    encoder = new TextEncoder();
    decoder = new TextDecoder();
    inflight = new Map();
    bodies = new Map();
    sockets = new Map();
    commands = new Map();
    watchers = new Set();
    counters = {
        initializations: 0, runs: 0, completed: 0, failed: 0, cancelled: 0, retries: 0, waits: 0, resumes: 0, rejected_runs: 0, cancellations: 0,
        host_calls: 0, store_calls: 0, log_calls: 0, model_requests: 0, model_sockets: 0, socket_sends: 0, socket_frames: 0, tool_calls: 0, body_reads: 0, event_batches: 0, events: 0,
        host_cancellations: 0, dropped_replies: 0, disposals: 0,
        bridge_request_bytes: 0, bridge_reply_bytes: 0,
    };
    nextBody = 0;
    nextSocket = 0;
    nextCommand = 0;
    depth = 0;
    stopped = false;
    failure;
    disposal;
    attached = new Set();
    options;
    sql;
    hands = false;
    remote = false;
    subscription = false;
    opened = false;
    constructor(sql, options) {
        this.sql = sql;
        this.options = options;
    }
    static async instantiate(module, sql, options) {
        const runtime = new AgentRuntime(sql, options);
        const instantiateStarted = performance.now();
        const instance = await WebAssembly.instantiate(module, { host: runtime.imports() });
        runtime.timings.record("wasm.instantiate", performance.now() - instantiateStarted);
        runtime.wasm = instance.exports;
        if (sql.value_limit !== undefined)
            await runtime.command("configure", { value_limit: sql.value_limit });
        return runtime;
    }
    async open(config, options) {
        if (this.opened || this.closed)
            throw new Error("agent runtime cannot be opened again");
        this.opened = true;
        this.options = { ...options, published: this.options.published, wake: this.options.wake };
        this.hands = config.hands ?? false;
        this.remote = config.remote ?? false;
        this.subscription = config.subscription;
        try {
            const initStarted = performance.now();
            const opened = await this.command("init", { config: { scope: config.scope, session_id: config.session_id, runtime_id: this.runtimeId, started_ms: this.started, provider: config.provider ?? "claude", model: config.model, thinking: config.thinking, instructions: config.instructions, subscription: config.subscription, endpoint: config.endpoint, gateway: config.gateway, remote: config.remote ?? false, executor: config.executor, hands: this.hands, event_coalesce_ms: config.event_coalesce_ms ?? 0, tools: config.tools ?? [] } });
            if (opened.rejected)
                throw new HostFailure(opened.rejected.error, opened.rejected.kind, true);
            this.timings.record("sdk.open", performance.now() - initStarted);
        }
        catch (error) {
            this.terminate(error);
            throw error;
        }
        this.counters.initializations++;
    }
    get metrics() {
        return { ...this.counters, wasm_memory_bytes: this.wasm.memory.buffer.byteLength, timing: { runtime_id: this.runtimeId, started_at: this.startedAt, elapsed_ms: this.elapsed(), spans: this.timings.snapshot(), checkpoints: this.checkpointTimings.snapshot(), models: this.models.map(value => ({ ...value })) } };
    }
    get closed() {
        return this.stopped || this.disposal !== undefined;
    }
    get reusable() {
        return !this.closed && !this.options.remote?.failed?.();
    }
    get memoryBytes() {
        return this.wasm.memory.buffer.byteLength;
    }
    get connected() {
        for (const entry of this.sockets.values())
            if (entry.closed === undefined)
                return true;
        return false;
    }
    async submit(scope, input) {
        return await this.command("submit", { scope, ...input });
    }
    async admit(request_id, recorded, requested) {
        return (await this.command("admit", { request_id, recorded, requested }))?.rejected;
    }
    async catalog(frame, max_frame_bytes) {
        return (await this.identity(frame, max_frame_bytes)).name;
    }
    async identity(frame, max_frame_bytes) {
        return await this.command("catalog", { frame, max_frame_bytes });
    }
    async turn(scope, request_id) {
        return (await this.command("turn", { scope, request_id })).turn;
    }
    async pending(scope) {
        return (await this.command("pending", { scope })).turns;
    }
    async page(scope, after, limit, request_id) {
        return await this.command("page", { scope, after, limit, request_id });
    }
    async interrupted(scope, request_id, note) {
        await this.command("interrupted", { scope, request_id, note });
    }
    async retry(scope, request_id, error, kind, retry_at) {
        return (await this.command("retry", { scope, request_id, error, kind, retry_at })).turn;
    }
    async finish(scope, request_id, status, fields) {
        await this.command("finish", { scope, request_id, status, fields });
    }
    async import(scope, turns) {
        return await this.command("import", { scope, turns });
    }
    async cancel(scope, request_id, fields) {
        this.counters.cancellations++;
        return await this.command("cancel", { scope, request_id, fields });
    }
    async drive(next) {
        if (this.closed)
            throw this.failure ?? new Error("agent runtime is closed");
        this.counters.runs++;
        let result;
        try {
            result = await this.command("drive", { next });
        }
        catch {
            result = { retry: true };
        }
        const status = result.finished?.report.status;
        if (status === "completed")
            this.counters.completed++;
        else if (status === "cancelled")
            this.counters.cancelled++;
        else if (status === "failed")
            this.counters.failed++;
        else if (result.retry)
            this.counters.retries++;
        else if (result.busy)
            this.counters.rejected_runs++;
        else if (result.waiting)
            this.counters.waits++;
        else if (result.resumed !== undefined)
            this.counters.resumes++;
        if (result.retry)
            await this.dispose().catch(() => undefined);
        return result;
    }
    async attach(hand, connection) {
        if (this.closed || this.attached.has(connection))
            return;
        this.attached.add(connection);
        try {
            await this.command("attach", { hand, connection });
        }
        catch (error) {
            this.attached.delete(connection);
            throw error;
        }
    }
    async detach(connection) {
        if (this.closed || !this.attached.delete(connection))
            return;
        await this.command("detach", { connection });
    }
    async settle() {
        return await this.command("settle", {}) === true;
    }
    async steer(requestId, prompt) {
        return await this.command("steer", { request_id: requestId, prompt }) === true;
    }
    async checkThinking(thinking) {
        await this.command("thinking", { thinking, apply: false });
    }
    async setThinking(thinking) {
        await this.command("thinking", { thinking, apply: true });
    }
    async preconnect() {
        await this.command("preconnect", {});
    }
    changed(signal) {
        if (this.stopped || signal?.aborted)
            return Promise.resolve();
        return new Promise(resolve => {
            const done = () => {
                this.watchers.delete(done);
                signal?.removeEventListener("abort", done);
                resolve();
            };
            this.watchers.add(done);
            signal?.addEventListener("abort", done, { once: true });
        });
    }
    dispose() {
        this.disposal ??= this.shutdown();
        return this.disposal;
    }
    async shutdown() {
        this.counters.disposals++;
        let failure;
        if (!this.stopped && this.opened) {
            try {
                await this.command("dispose", {});
            }
            catch (error) {
                failure = error;
            }
        }
        this.terminate(new Error("agent runtime disposed"));
        await this.options.remote?.dispose();
        if (failure !== undefined)
            throw failure;
    }
    accept(id, pointer, length, body) {
        const received = performance.now();
        const request = JSON.parse(this.read(pointer, length));
        if (body)
            request.body = body;
        this.counters.bridge_request_bytes += length + (body?.byteLength ?? 0);
        this.timings.record("bridge.decode", performance.now() - received);
        this.counters.host_calls++;
        this.inflight.set(id, () => { });
        void Promise.resolve()
            .then(async () => {
            const started = performance.now();
            this.timings.record(`queue.${request.op}`, started - received);
            try {
                return await this.execute(id, request);
            }
            finally {
                this.timings.record(`host.${request.op}`, performance.now() - started);
            }
        })
            .then(ok => ({ ok }), error => ({ error: AgentRuntime.encodeError(error) }))
            .then(reply => this.complete(id, reply));
    }
    imports() {
        return {
            dispatch: (id, pointer, length) => this.accept(id, pointer, length),
            dispatch_body: (id, pointer, length, body, bodyLength) => this.accept(id, pointer, length, new Uint8Array(this.wasm.memory.buffer, body, bodyLength).slice()),
            cancel: (id) => {
                const cancel = this.inflight.get(id);
                if (!cancel)
                    return;
                this.inflight.delete(id);
                this.counters.host_cancellations++;
                cancel();
            },
            clock: (monotonic) => monotonic ? performance.now() : Date.now(),
            random: (pointer, length) => { crypto.getRandomValues(new Uint8Array(this.wasm.memory.buffer, pointer, length)); },
            reply: (id, pointer, length) => {
                const reply = JSON.parse(this.read(pointer, length));
                const pending = this.commands.get(id);
                if (!pending)
                    return;
                this.commands.delete(id);
                if ("error" in reply)
                    pending.reject(new Error(String(reply.error)));
                else
                    pending.resolve(reply.ok);
                this.notify();
            },
            panicked: (pointer, length) => { this.fail(new Error(this.read(pointer, length))); },
        };
    }
    onCancel(id, cancel) {
        if (this.inflight.has(id))
            this.inflight.set(id, cancel);
        else
            cancel();
    }
    live(id) {
        return !this.stopped && this.inflight.has(id);
    }
    async execute(id, request) {
        if (!this.live(id))
            return null;
        if (request.op.startsWith("remote_")) {
            if (!this.options.remote)
                throw new Error("remote executor is not configured");
            this.onCancel(id, () => this.options.remote.cancel(id));
            return this.options.remote.execute(request, id);
        }
        switch (request.op) {
            case "wake":
                this.notify();
                this.options.wake?.();
                return null;
            case "sleep": return new Promise(resolve => {
                const timer = setTimeout(() => resolve(null), request.milliseconds);
                this.onCancel(id, () => { clearTimeout(timer); resolve(null); });
            });
            case "http_start": {
                if (!this.options.dispatch)
                    throw new Error("agent runtime is not open");
                this.counters.model_requests++;
                const controller = new AbortController();
                this.onCancel(id, () => controller.abort());
                const timing = { runtime_id: this.runtimeId, dispatch_id: id, started_ms: this.elapsed(), body_read_wait_ms: 0, body_reads: 0, bytes: 0, max_chunk_gap_ms: 0 };
                this.models.push(timing);
                if (this.models.length > RECENT_MODEL_LIMIT)
                    this.models.shift();
                let response;
                try {
                    response = await this.options.dispatch({ endpoint: request.endpoint, headers: request.headers, body: request.body }, controller.signal, timing);
                }
                catch (error) {
                    this.finishModel(timing, controller.signal.aborted ? "cancelled" : "failed");
                    throw error;
                }
                timing.headers_ms = this.elapsed() - timing.started_ms;
                timing.status = response.status;
                if (!this.live(id)) {
                    void response.body?.cancel().catch(() => undefined);
                    this.finishModel(timing, "cancelled");
                    return null;
                }
                if (response.status >= 300 && response.status < 400) {
                    void response.body?.cancel().catch(() => undefined);
                    this.finishModel(timing, "failed");
                    throw new Error("provider redirect rejected");
                }
                if (!response.body) {
                    this.finishModel(timing, "failed");
                    throw new Error("provider response has no body");
                }
                const body = ++this.nextBody;
                const reader = response.body.getReader();
                this.bodies.set(body, { reader, timing });
                this.onCancel(id, () => {
                    if (!this.bodies.delete(body))
                        return;
                    this.finishModel(timing, "cancelled");
                    void reader.cancel().catch(() => undefined);
                });
                return { id: body, status: response.status, headers: [...response.headers] };
            }
            case "http_read": {
                const body = this.bodies.get(request.id);
                if (!body)
                    throw new Error("provider response body is closed");
                const { reader, timing } = body;
                this.counters.body_reads++;
                this.onCancel(id, () => {
                    this.bodies.delete(request.id);
                    this.finishModel(timing, "cancelled");
                    void reader.cancel().catch(() => undefined);
                });
                const readStarted = performance.now();
                let chunk;
                try {
                    chunk = await reader.read();
                }
                catch (error) {
                    this.finishModel(timing, "failed");
                    throw error;
                }
                finally {
                    timing.body_read_wait_ms += performance.now() - readStarted;
                    timing.body_reads++;
                }
                if (chunk.done) {
                    this.bodies.delete(request.id);
                    reader.releaseLock();
                    this.finishModel(timing, "eof");
                    return null;
                }
                const at = this.elapsed() - timing.started_ms;
                if (chunk.value.byteLength)
                    timing.first_byte_ms ??= at;
                if (timing.last_byte_ms !== undefined)
                    timing.max_chunk_gap_ms = Math.max(timing.max_chunk_gap_ms, at - timing.last_byte_ms);
                timing.last_byte_ms = at;
                timing.bytes += chunk.value.byteLength;
                return chunk.value;
            }
            case "http_close": {
                const body = this.bodies.get(request.id);
                if (body) {
                    this.bodies.delete(request.id);
                    this.finishModel(body.timing, "closed");
                    await body.reader.cancel().catch(() => undefined);
                }
                return null;
            }
            case "tool_call": {
                if (!this.options.tools)
                    throw new Error("host tools are not configured");
                this.counters.tool_calls++;
                const controller = new AbortController();
                this.onCancel(id, () => controller.abort());
                return await this.options.tools.call(request.name, request.input, controller.signal, { call_id: request.call_id }) ?? null;
            }
            case "socket_open": {
                if (!this.options.socket)
                    throw new Error("model sockets are not configured");
                this.counters.model_sockets++;
                const controller = new AbortController();
                this.onCancel(id, () => controller.abort());
                const timing = { runtime_id: this.runtimeId, dispatch_id: id, transport: "websocket", started_ms: this.elapsed(), body_read_wait_ms: 0, body_reads: 0, bytes: 0, max_chunk_gap_ms: 0, sends: 0 };
                this.models.push(timing);
                if (this.models.length > RECENT_MODEL_LIMIT)
                    this.models.shift();
                let handshake;
                try {
                    handshake = await this.options.socket.open({ headers: request.headers }, controller.signal, timing);
                }
                catch (error) {
                    this.finishModel(timing, controller.signal.aborted ? "cancelled" : "failed");
                    throw error;
                }
                timing.headers_ms = this.elapsed() - timing.started_ms;
                timing.status = handshake.status;
                const socket = handshake.socket;
                if (handshake.status !== 101 || !socket) {
                    this.finishModel(timing, "failed");
                    return { status: handshake.status, headers: [...handshake.headers], body: await handshake.text() };
                }
                if (!this.live(id)) {
                    socket.close(1000, "handshake cancelled");
                    this.finishModel(timing, "cancelled");
                    return null;
                }
                const handle = ++this.nextSocket;
                const idle = handshake.idle_ms ?? 0;
                const entry = { socket, idle: Number.isSafeInteger(idle) && idle > 0 ? idle : 0, frames: [], watchers: [], timing };
                this.sockets.set(handle, entry);
                socket.addEventListener("message", event => this.receive(entry, event.data));
                socket.addEventListener("close", event => this.closeSocket(handle, `with code ${event.code}: ${event.reason}`, "eof"));
                socket.addEventListener("error", () => this.closeSocket(handle, "after a transport error", "failed"));
                this.onCancel(id, () => {
                    this.closeSocket(handle, "handshake cancelled", "cancelled");
                    this.sockets.delete(handle);
                });
                return { id: handle, status: handshake.status, headers: [...handshake.headers] };
            }
            case "socket_send": {
                const entry = this.sockets.get(request.id);
                if (entry?.closed !== undefined)
                    return { closed: entry.closed };
                if (!entry)
                    return { closed: "after the client released it" };
                await this.options.socket.admit();
                if (entry.closed !== undefined)
                    return { closed: entry.closed };
                try {
                    entry.socket.send(this.decoder.decode(request.body));
                }
                catch {
                    this.closeSocket(request.id, "before request dispatch", "failed");
                    return { closed: entry.closed };
                }
                entry.timing.sends = (entry.timing.sends ?? 0) + 1;
                this.counters.socket_sends++;
                return null;
            }
            case "socket_next": {
                const entry = this.sockets.get(request.id);
                if (!entry)
                    return { closed: "after the client released it" };
                if (entry.frames.length)
                    return this.frame(entry);
                if (entry.closed !== undefined)
                    return { closed: entry.closed };
                if (entry.waiter)
                    throw new Error("socket_next is already pending");
                const readStarted = performance.now();
                try {
                    return await new Promise(resolve => {
                        const timer = entry.idle ? setTimeout(() => this.closeSocket(request.id, "after the stream idle deadline elapsed", "failed"), entry.idle) : undefined;
                        const clear = () => { if (timer !== undefined)
                            clearTimeout(timer); };
                        entry.waiter = { id, resolve: value => { clear(); resolve(value); } };
                        this.onCancel(id, () => {
                            clear();
                            if (entry.waiter?.id === id)
                                entry.waiter = undefined;
                            resolve(null);
                        });
                    });
                }
                finally {
                    entry.timing.body_read_wait_ms += performance.now() - readStarted;
                }
            }
            case "socket_wait": {
                const entry = this.sockets.get(request.id);
                if (!entry || entry.closed !== undefined)
                    return null;
                return new Promise(resolve => {
                    entry.watchers.push(() => resolve(null));
                    this.onCancel(id, () => resolve(null));
                });
            }
            case "socket_close": {
                this.closeSocket(request.id, "by the client", "closed");
                this.sockets.delete(request.id);
                return null;
            }
            case "events": {
                this.counters.event_batches++;
                this.counters.events += request.events.length;
                this.options.published(request.events, request.bytes);
                this.notify();
                return null;
            }
            case "turn_finished": return await this.options.finishing?.(request.request_id) ?? {};
            case "store": {
                this.counters.store_calls++;
                const started = performance.now();
                try {
                    return this.rows(await this.sql.transaction("store", request.operation, request.statements));
                }
                finally {
                    this.checkpointTimings.record(request.operation, performance.now() - started);
                }
            }
            case "log": {
                this.counters.log_calls++;
                return this.rows(await this.sql.transaction("log", request.operation, request.statements));
            }
            default: throw new Error("unsupported host operation");
        }
    }
    notify() {
        for (const watcher of [...this.watchers])
            watcher();
    }
    rows(statements) {
        let capacity = 4;
        for (const rows of statements) {
            capacity += 4;
            for (const row of rows) {
                capacity += 4 + 4 * row.length;
                for (const cell of row)
                    if (typeof cell === "string")
                        capacity += 3 * cell.length;
            }
        }
        const bytes = new Uint8Array(capacity);
        const view = new DataView(bytes.buffer);
        let offset = 0;
        const count = (value) => { view.setUint32(offset, value, true); offset += 4; };
        count(statements.length);
        for (const rows of statements) {
            count(rows.length);
            for (const row of rows) {
                count(row.length);
                for (const cell of row) {
                    if (cell === null) {
                        count(NULL_CELL);
                        continue;
                    }
                    if (typeof cell !== "string")
                        throw new Error("SQL host returned a value that is neither text nor null");
                    const { written } = this.encoder.encodeInto(cell, bytes.subarray(offset + 4));
                    count(written);
                    offset += written;
                }
            }
        }
        return bytes.subarray(0, offset);
    }
    receive(entry, data) {
        if (entry.closed !== undefined)
            return;
        const at = this.elapsed() - entry.timing.started_ms;
        entry.timing.first_byte_ms ??= at;
        entry.timing.last_byte_ms = at;
        entry.timing.body_reads++;
        this.counters.socket_frames++;
        entry.frames.push(typeof data === "string" ? data : null);
        const waiter = entry.waiter;
        if (!waiter)
            return;
        entry.waiter = undefined;
        waiter.resolve(this.frame(entry));
    }
    frame(entry) {
        const frame = entry.frames.shift();
        if (frame === null || frame === undefined)
            return { binary: true };
        const bytes = this.encoder.encode(frame);
        entry.timing.bytes += bytes.byteLength;
        return bytes;
    }
    closeSocket(handle, detail, outcome) {
        const entry = this.sockets.get(handle);
        if (!entry || entry.closed !== undefined)
            return;
        entry.closed = detail;
        this.finishModel(entry.timing, outcome);
        try {
            entry.socket.close(1000, "closed");
        }
        catch { }
        const waiter = entry.waiter;
        entry.waiter = undefined;
        waiter?.resolve({ closed: detail });
        for (const watcher of entry.watchers.splice(0))
            watcher();
    }
    releaseConnections() {
        this.closeSockets("released while the session is idle", "closed");
    }
    closeSockets(detail, outcome) {
        for (const handle of [...this.sockets.keys()])
            this.closeSocket(handle, detail, outcome);
    }
    complete(id, reply) {
        if (!this.live(id)) {
            this.counters.dropped_replies++;
            return;
        }
        this.inflight.delete(id);
        this.enter(() => {
            if ("ok" in reply && reply.ok instanceof Uint8Array)
                this.wasm.complete_bytes(id, ...this.writeBytes(reply.ok));
            else
                this.wasm.complete(id, ...this.write(reply));
        });
    }
    command(op, fields) {
        if (this.stopped)
            return Promise.reject(this.failure ?? new Error("agent runtime is closed"));
        const id = ++this.nextCommand;
        return new Promise((resolve, reject) => {
            this.commands.set(id, { resolve, reject });
            this.enter(() => this.wasm.command(id, ...this.write({ [op]: fields })));
        });
    }
    enter(call) {
        if (this.depth > 0) {
            queueMicrotask(() => this.enter(call));
            return;
        }
        if (this.stopped)
            return;
        this.depth++;
        const started = performance.now();
        try {
            call();
            this.wasm.poll();
        }
        catch (error) {
            this.fail(error);
        }
        finally {
            this.timings.record("wasm.enter", performance.now() - started);
            this.depth--;
        }
    }
    fail(error) {
        this.failure ??= error instanceof Error ? error : new Error(String(error));
        this.terminate(this.failure);
    }
    terminate(reason) {
        if (this.stopped)
            return;
        this.stopped = true;
        const cancellations = [...this.inflight.values()];
        this.counters.host_cancellations += cancellations.length;
        this.inflight.clear();
        for (const cancel of cancellations)
            cancel();
        for (const { reader, timing } of this.bodies.values()) {
            this.finishModel(timing, "cancelled");
            void reader.cancel().catch(() => undefined);
        }
        this.bodies.clear();
        this.closeSockets("agent runtime disposed", "cancelled");
        this.sockets.clear();
        const commands = [...this.commands.values()];
        this.commands.clear();
        for (const pending of commands)
            pending.reject(reason);
        this.notify();
    }
    read(pointer, length) {
        return this.decoder.decode(new Uint8Array(this.wasm.memory.buffer, pointer, length));
    }
    write(value) {
        const started = performance.now();
        try {
            return this.writeBytes(this.encoder.encode(JSON.stringify(value)));
        }
        finally {
            this.timings.record("bridge.encode", performance.now() - started);
        }
    }
    writeBytes(bytes) {
        const started = performance.now();
        this.counters.bridge_reply_bytes += bytes.byteLength;
        const pointer = this.wasm.allocate(bytes.length);
        new Uint8Array(this.wasm.memory.buffer, pointer, bytes.length).set(bytes);
        this.timings.record("bridge.copy", performance.now() - started);
        return [pointer, bytes.length];
    }
    static encodeError(error) {
        return { detail: error instanceof Error ? error.message : String(error), ...(error instanceof RemoteRefusal ? { unsent: true } : {}) };
    }
    elapsed() { return performance.now() - this.started; }
    finishModel(timing, outcome) {
        if (timing.outcome)
            return;
        timing.outcome = outcome;
        timing.duration_ms = this.elapsed() - timing.started_ms;
    }
}
