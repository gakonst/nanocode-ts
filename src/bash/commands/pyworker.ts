import { CommandError, type CommandContext } from "../shell.ts";


export type PythonJob = { kind: string; name: string; target: string; argv: string[]; filename: string; cwd: string; env: Record<string, string>; path0: string; roots: string[]; dirs: string[]; files: [string, Uint8Array][]; stdin: Uint8Array };

export type PythonTree = { files: Map<string, Uint8Array>; dirs: Set<string> };

type Port = { postMessage(message: unknown, transfer?: unknown[]): void; on(event: string, listener: (value: unknown) => void): void; terminate(): Promise<number>; unref?(): void; ref?(): void };

type WorkerThreads = { Worker: new (source: string, options: { eval: true; workerData: unknown; resourceLimits?: Record<string, number> }) => Port };

type Pending = { resolve(value: Record<string, unknown>): void; reject(error: Error): void; output?(fd: number, text: string): void };

type Remote = { port: Port; pending: Map<number, Pending>; next: number; failed?: Error };

const SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const RESERVED = ["/dev", "/proc", "/lib", "/home/pyodide", "/home/web_user"];
const reserved = path => RESERVED.some(prefix => path === prefix || path.startsWith(prefix + "/"));
const join = (base, name) => base === "/" ? "/" + name : base + "/" + name;
const within = (path, dir) => path === dir || path.startsWith(dir === "/" ? "/" : dir + "/");
const parentOf = path => { const i = path.lastIndexOf("/"); return i <= 0 ? "/" : path.slice(0, i); };
const decoder = new TextDecoder();
let py, start, cancel, loading, micropip = false, mirrored = [];
async function load() {
  let mod;
  for (const from of [process.cwd() + "/package.json", workerData.from]) {
    try { mod = createRequire(from)("pyodide"); break; } catch {}
  }
  if (!mod) mod = await import("pyodide");
  py = await mod.loadPyodide({ packageCacheDir: workerData.cacheDir, stdout: () => {}, stderr: () => {} });
  const ns = py.globals.get("dict")();
  py.runPython(workerData.helper, { globals: ns });
  start = ns.get("start");
  cancel = ns.get("cancel");
}
function unmirror(fs, path) {
  if (reserved(path) || !fs.analyzePath(path).exists) return;
  if (!fs.isDir(fs.stat(path).mode)) return fs.unlink(path);
  for (const name of fs.readdir(path)) if (name !== "." && name !== "..") unmirror(fs, join(path, name));
  if (path !== "/" && !RESERVED.some(prefix => within(prefix, path))) fs.rmdir(path);
}
function collect(fs, roots) {
  const files = new Map(), dirs = new Set();
  const visit = path => {
    if (reserved(path) || files.has(path) || dirs.has(path) || !fs.analyzePath(path).exists) return;
    const mode = fs.stat(path).mode;
    if (fs.isFile(mode)) files.set(path, fs.readFile(path));
    if (!fs.isDir(mode)) return;
    dirs.add(path);
    for (const name of fs.readdir(path)) if (name !== "." && name !== "..") visit(join(path, name));
  };
  for (const root of roots) visit(root);
  return { files, dirs };
}
async function run(id, job) {
  const fs = py.FS;
  const out = (fd, text) => parentPort.postMessage({ id, type: "out", fd, text });
  fs.chdir("/");
  for (const path of mirrored) unmirror(fs, path);
  mirrored = job.roots;
  for (const dir of job.dirs) fs.mkdirTree(dir);
  for (const [path, data] of job.files) { fs.mkdirTree(parentOf(path)); fs.writeFile(path, data); }
  fs.mkdirTree(job.cwd);
  const messages = { messageCallback: () => {}, errorCallback: message => out(2, message + "\n") };
  try {
    if (job.kind === "pip" && !micropip) { await py.loadPackage("micropip", messages); micropip = true; }
    if (job.kind === "module") await py.loadPackagesFromImports("import " + job.target, messages);
    else if (job.kind !== "pip") await py.loadPackagesFromImports(job.target, messages);
  } catch (error) {
    out(2, job.name + ": " + (error && error.message || String(error)) + "\n");
  }
  let offset = 0;
  py.setStdin({ isatty: false, read(buffer) { const count = Math.min(buffer.length, job.stdin.length - offset); buffer.set(job.stdin.subarray(offset, offset + count)); offset += count; return count; } });
  const sink = fd => ({ isatty: false, write(buffer) { out(fd, decoder.decode(buffer)); return buffer.length; } });
  py.setStdout(sink(1));
  py.setStderr(sink(2));
  py.setInterruptBuffer(new Int32Array(job.interrupt));
  let status;
  try {
    status = Number(await start(JSON.stringify({ kind: job.kind, target: job.target, argv: job.argv, filename: job.filename, cwd: job.cwd, env: job.env, path0: job.path0 })));
  } finally {
    py.setInterruptBuffer(undefined);
  }
  const tree = collect(fs, job.roots);
  parentPort.postMessage({ id, type: "done", status, files: tree.files, dirs: tree.dirs });
}
parentPort.on("message", async message => {
  if (message.type === "cancel") { try { cancel && cancel(); } catch {} return; }
  try {
    await (loading ??= load());
    if (message.type === "version") return parentPort.postMessage({ id: message.id, type: "done", version: String(py.runPython("import sys; sys.version.split()[0]")) });
    if (message.type === "preload") { await py.loadPackage(message.packages, { messageCallback: () => {}, errorCallback: () => {} }); return parentPort.postMessage({ id: message.id, type: "done" }); }
    await run(message.id, message.job);
  } catch (error) {
    parentPort.postMessage({ id: message.id, type: "error", message: error && error.stack || String(error) });
  }
});
`;

let remote: Remote | undefined;

let queue: Promise<unknown> = Promise.resolve();

function threads(): WorkerThreads | undefined {
  const process = (globalThis as { process?: { versions?: { node?: string }; getBuiltinModule?: (id: string) => unknown } }).process;
  if (typeof process?.versions?.node !== "string") return undefined;
  try {
    return process.getBuiltinModule?.("node:worker_threads") as WorkerThreads | undefined;
  } catch {
    return undefined;
  }
}

export function pythonWorkers(): boolean {
  return threads() !== undefined && typeof SharedArrayBuffer === "function" && typeof Atomics === "object";
}

function spawn(helper: string, cacheDir: string): Remote {
  const { Worker } = threads()!;
  const port = new Worker(SOURCE, { eval: true, workerData: { helper, cacheDir, from: (import.meta as { url?: string }).url ?? "" } });
  const current: Remote = { port, pending: new Map(), next: 0 };
  const fail = (error: Error) => {
    current.failed ??= error;
    if (remote === current) remote = undefined;
    for (const pending of current.pending.values()) pending.reject(error);
    current.pending.clear();
  };
  port.on("message", (message: unknown) => {
    const data = message as { id: number; type: string; fd?: number; text?: string; message?: string };
    const pending = current.pending.get(data.id);
    if (!pending) return;
    if (data.type === "out") return pending.output?.(data.fd ?? 1, data.text ?? "");
    current.pending.delete(data.id);
    if (!current.pending.size) port.unref?.();
    if (data.type === "error") pending.reject(new Error(data.message ?? "python worker failed"));
    else pending.resolve(data as unknown as Record<string, unknown>);
  });
  port.on("error", (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
  port.on("exit", (code: unknown) => fail(new Error("the python worker exited with code " + String(code))));
  port.unref?.();
  return current;
}

function call(helper: string, cacheDir: string, message: Record<string, unknown>, output?: Pending["output"], transfer: unknown[] = []): { remote: Remote; result: Promise<Record<string, unknown>> } {
  const current = remote ??= spawn(helper, cacheDir);
  const id = ++current.next;
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    current.pending.set(id, { resolve, reject, ...(output ? { output } : {}) });
  });
  current.port.ref?.();
  current.port.postMessage({ ...message, id }, transfer);
  return { remote: current, result };
}

function serial<T>(work: () => Promise<T>): Promise<T> {
  const task = queue.then(work);
  queue = task.catch(() => {});
  return task;
}

export function workerVersion(helper: string, cacheDir: string): Promise<string> {
  return serial(async () => String((await call(helper, cacheDir, { type: "version" }).result)["version"]));
}

export function workerPreload(helper: string, cacheDir: string, packages: string[]): Promise<void> {
  return serial(async () => void await call(helper, cacheDir, { type: "preload", packages }).result);
}

export function workerRun(helper: string, cacheDir: string, ctx: CommandContext, job: PythonJob): Promise<{ status: number; tree: PythonTree; failure?: unknown }> {
  return serial(async () => {
    const interrupt = new SharedArrayBuffer(4);
    const flag = new Int32Array(interrupt);
    const deadline = Date.now() + ctx.limits.timeoutMs;
    let failure: unknown;
    const output = (fd: number, text: string) => {
      try {
        (fd === 2 ? ctx.stderr : ctx.stdout).write(text);
      } catch (error) {
        failure ??= error;
      }
    };
    const { remote: current, result } = call(helper, cacheDir, { type: "run", job: { ...job, interrupt } }, output);
    let killed: string | undefined;
    let stoppedAt = 0;
    const watch = setInterval(() => {
      const stopped = failure !== undefined || ctx.signal.aborted || Date.now() > deadline;
      if (!stopped) return;
      stoppedAt ||= Date.now();
      Atomics.store(flag, 0, 2);
      current.port.postMessage({ type: "cancel" });
      if (Date.now() - stoppedAt > 3000 && !killed) {
        killed = ctx.signal.aborted ? "interrupted" : failure !== undefined ? "output" : "timeout";
        void current.port.terminate();
      }
    }, 50);
    try {
      const done = await result.catch((error: unknown) => {
        if (killed) return undefined;
        throw error;
      });
      if (!done) {
        if (killed === "output") throw failure;
        if (killed === "interrupted") throw new CommandError("interrupted", 130);
        throw new CommandError("timed out after " + ctx.limits.timeoutMs + " ms (the python process was killed)", 124);
      }
      return { status: Number(done["status"]), tree: { files: done["files"] as Map<string, Uint8Array>, dirs: done["dirs"] as Set<string> }, ...(failure !== undefined ? { failure } : {}) };
    } finally {
      clearInterval(watch);
    }
  });
}

