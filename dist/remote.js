import { RemoteRefusal } from "./contracts.js";
const encoder = new TextEncoder();
function validate(policy) {
    for (const key of ["max_frame_bytes", "timeout_ms"]) {
        if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0)
            throw new Error(`remote ${key} must be a positive integer`);
    }
}
export class RemoteExecutor {
    #socket;
    #policy;
    #catalog;
    #catalogWaiter;
    #frames = [];
    #waiter;
    #failure;
    #owner;
    #closed;
    closed = new Promise(resolve => { this.#closed = resolve; });
    constructor(socket, policy, listen) {
        this.#socket = socket;
        this.#policy = policy;
        if (!listen)
            return;
        socket.addEventListener("message", event => this.receive(event.data));
        socket.addEventListener("close", () => this.disconnected());
        socket.addEventListener("error", () => this.disconnected("runner connection failed"));
    }
    static accept(socket, policy) {
        validate(policy);
        return new RemoteExecutor(socket, policy, false);
    }
    static restore(socket, policy, catalog) {
        const executor = RemoteExecutor.accept(socket, policy);
        executor.#catalog = catalog;
        return executor;
    }
    async ready() {
        let timer;
        try {
            await Promise.race([this.#catalogReady(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("hand catalog deadline elapsed")), this.#policy.timeout_ms); })]);
        }
        catch (error) {
            this.#fail(error instanceof Error ? error.message : String(error), 1011);
            throw error;
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    static async connect(open, policy) {
        validate(policy);
        const controller = new AbortController();
        let expire;
        const deadline = new Promise((_, reject) => { expire = reject; });
        const timer = setTimeout(() => {
            controller.abort();
            expire(new Error("remote executor connection deadline elapsed"));
        }, policy.timeout_ms);
        let executor;
        try {
            const socket = await Promise.race([open(controller.signal), deadline]);
            executor = new RemoteExecutor(socket, policy, true);
            await Promise.race([executor.#catalogReady(), deadline]);
            return executor;
        }
        catch (error) {
            if (executor)
                executor.#fail(error instanceof Error ? error.message : String(error), 1011);
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
    get failure() {
        return this.#failure;
    }
    get catalog() {
        return this.#catalog;
    }
    get socket() {
        return this.#socket;
    }
    disconnected(reason = "runner disconnected") {
        this.#fail(reason, reason === "runner disconnected" ? 1000 : 1011);
    }
    reject(reason) {
        this.#fail(reason, 1002);
    }
    refuse(reason) {
        this.#fail(reason, 1008, reason);
    }
    async execute(request, id) {
        switch (request.op) {
            case "remote_catalog":
                return { frame: this.#catalog, max_frame_bytes: this.#policy.max_frame_bytes, timeout_ms: this.#policy.timeout_ms };
            case "remote_send": {
                if (this.#failure !== undefined)
                    throw new RemoteRefusal(this.#failure);
                let sent = 0;
                try {
                    for (const frame of request.frames ?? []) {
                        this.#socket.send(frame);
                        sent++;
                    }
                }
                catch (error) {
                    throw sent ? error : new RemoteRefusal(error instanceof Error ? error.message : String(error));
                }
                return null;
            }
            case "remote_poll":
                if (this.#frames.length)
                    return { frames: this.#frames.splice(0) };
                if (this.#failure !== undefined)
                    return { closed: this.#failure };
                if (this.#waiter)
                    throw new Error("remote_poll is already pending");
                return new Promise(resolve => { this.#waiter = { id, resolve }; });
            case "remote_close":
                this.#fail(String(request.reason), 1000);
                return null;
            default:
                throw new Error(`unsupported remote operation ${request.op}`);
        }
    }
    claim(owner) {
        if (this.#owner === owner)
            return;
        this.#owner = owner;
        const waiter = this.#waiter;
        this.#waiter = undefined;
        waiter?.resolve({ closed: "connection moved to a newer runtime" });
    }
    release() {
        this.#owner = {};
    }
    owns(owner) {
        return this.#owner === owner;
    }
    cancel(id) {
        if (this.#waiter?.id !== id)
            return;
        this.#waiter.resolve(null);
        this.#waiter = undefined;
    }
    async dispose() {
        this.#fail("remote executor disposed", 1000);
    }
    #catalogReady() {
        if (this.#catalog !== undefined)
            return Promise.resolve();
        if (this.#failure !== undefined)
            return Promise.reject(new Error(this.#failure));
        return new Promise((resolve, reject) => { this.#catalogWaiter = { resolve, reject }; });
    }
    receive(data) {
        if (this.#failure !== undefined)
            return;
        if (typeof data !== "string")
            return this.#fail("remote code mode requires JSON text frames", 1003);
        if (encoder.encode(data).byteLength > this.#policy.max_frame_bytes)
            return this.#fail("remote code mode frame exceeds caller max_frame_bytes policy", 1009);
        if (this.#catalog === undefined) {
            this.#catalog = data;
            this.#catalogWaiter?.resolve();
            this.#catalogWaiter = undefined;
            return;
        }
        this.#frames.push(data);
        const waiter = this.#waiter;
        if (!waiter)
            return;
        this.#waiter = undefined;
        waiter.resolve({ frames: this.#frames.splice(0) });
    }
    #fail(reason, code, told) {
        if (this.#failure !== undefined)
            return;
        this.#failure = reason;
        this.#closed(reason);
        try {
            this.#socket.close(code, told);
        }
        catch { }
        this.#catalogWaiter?.reject(new Error(reason));
        this.#catalogWaiter = undefined;
        const waiter = this.#waiter;
        this.#waiter = undefined;
        waiter?.resolve({ closed: reason });
    }
}
