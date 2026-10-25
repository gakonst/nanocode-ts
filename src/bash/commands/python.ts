import { CommandError, type CommandContext, type CommandHandler } from "../shell.ts";
import { breathe, decode, encode, FsError, parentOf, type FileSystem } from "../fs.ts";
import { mkdirs } from "./files.ts";
import { pythonWorkers, workerPreload, workerRun, workerVersion } from "./pyworker.ts";

export const PYODIDE_VERSION = "314.0.7";

export const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/";

export type PyodideFS = {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  unlink(path: string): void;
  rmdir(path: string): void;
  analyzePath(path: string): { exists: boolean };
  chdir(path: string): void;
};

type Messages = { messageCallback?: (message: string) => void; errorCallback?: (message: string) => void };

type Stream = { write(buffer: Uint8Array): number; isatty?: boolean };

export type Pyodide = {
  FS: PyodideFS;
  globals: { get(name: string): unknown };
  runPython(code: string, options?: { globals?: unknown }): unknown;
  loadPackage(names: string | string[], options?: Messages): Promise<unknown>;
  loadPackagesFromImports(code: string, options?: Messages): Promise<unknown>;
  setStdin(options: { read(buffer: Uint8Array): number; isatty?: boolean }): void;
  setStdout(options: Stream): void;
  setStderr(options: Stream): void;
  setInterruptBuffer(buffer: unknown): void;
};

export type PythonRequest = { kind: "code" | "stdin" | "file" | "module" | "pip" | "version"; name: string; target: string; argv: string[]; filename: string; cwd: string; env: Record<string, string>; roots: string[]; dirs: string[]; files: [string, string][]; stdin: string; timeoutMs: number; mirror?: string; keep?: string[]; sync?: boolean; fetch?: string[]; range?: [number, number]; append?: boolean };

export type PythonReply = { status: number; stdout: string; stderr: string; dirs: string[]; files: [string, string | null][]; mirror?: string; missing?: string[]; more?: string[]; large?: [string, number][] };

export type PythonRemote = (request: PythonRequest, signal: AbortSignal) => Promise<PythonReply>;

export type PythonOptions = {
  remote?: PythonRemote;
  load?: () => Promise<Pyodide>;
  indexURL?: string;
  maxBytes?: number;
  maxFiles?: number;
  batchBytes?: number;
  worker?: boolean;
};

type Mode = { kind: "code" | "stdin" | "file" | "module" | "pip"; target: string; argv: string[]; filename: string };

type Tree = { files: Map<string, Uint8Array>; dirs: Set<string> };

type Snapshot = Tree & { partial: Set<string>; bytes: number; entries: number; left: number; leftBytes: number };

type Listing = { files: Map<string, string>; dirs: Set<string>; partial: Set<string>; bytes: number; left: number; leftBytes: number };

type Mirror = { id: string; known: Map<string, string> };

type Instance = { pyodide: Pyodide; start: (request: string) => PromiseLike<unknown>; cancel: () => unknown; mirrored: Set<string>; queue: Promise<unknown>; micropip: boolean };

const RESERVED = ["/dev", "/proc", "/lib", "/home/pyodide", "/home/web_user"];

const NO_WASM = "python3 needs a host that can compile WebAssembly; this one can't";

const HELPER = String.raw`
import asyncio, json, os, signal, sys, traceback, types
from pyodide.code import eval_code_async
sys.dont_write_bytecode = True
_base = set(sys.modules)
_active = False

class Interrupted(Exception):
    pass


def _status(error):
    code = error.code
    if code is None:
        return 0
    if isinstance(code, bool) or not isinstance(code, int):
        print(code, file=sys.stderr)
        return 1
    return code & 255

def _internal(code):
    name = code.co_filename
    return name in ("<exec>", "<nanocode>") or name.startswith("/lib/python") and ("/_pyodide/" in name or "/pyodide/" in name or name.endswith("/runpy.py"))

def _interrupt(signum, frame):
    while _active and frame is not None:
        if "/asyncio/" in frame.f_code.co_filename or frame.f_code.co_filename.endswith("/webloop.py"):
            return
        if not _internal(frame.f_code):
            raise Interrupted()
        frame = frame.f_back

signal.signal(signal.SIGINT, _interrupt)

_NETWORK = ("socket", "ssl", "http.client", "urllib.error", "urllib3", "requests", "httpx", "aiohttp")

def _offline(error):
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        kind = type(error)
        if isinstance(error, (ConnectionError, TimeoutError)) or kind.__module__.split(".")[0] in _NETWORK or kind.__module__ in _NETWORK or "TLS not supported" in str(error):
            return True
        tb = error.__traceback__
        while isinstance(error, OSError) and tb is not None:
            if tb.tb_frame.f_code.co_filename.endswith(("/socket.py", "/ssl.py", "/http/client.py", "/urllib/request.py")):
                return True
            tb = tb.tb_next
        error = error.__cause__ or error.__context__
    return False

def _report(error):
    tb = error.__traceback__
    while tb is not None and _internal(tb.tb_frame.f_code):
        tb = tb.tb_next
    traceback.print_exception(type(error), error, tb)
    if _offline(error):
        print("python3: Python here runs on Pyodide (WebAssembly) and cannot open network connections. Download the file with curl in bash first (curl -sL -o data.json URL), then read it from Python.", file=sys.stderr)

def _streams():
    sys.stdin = open("/dev/stdin", "r", encoding="utf-8", errors="surrogateescape")
    sys.stdout = open("/dev/stdout", "w", encoding="utf-8", errors="backslashreplace", buffering=1)
    sys.stderr = open("/dev/stderr", "w", encoding="utf-8", errors="backslashreplace", buffering=1)

async def _pip(args):
    import micropip
    if not args or args[0] in ("-h", "--help", "help"):
        print("usage: pip install [-r FILE] [--no-deps] [--pre] [-i URL] PKG... | uninstall PKG... | list | freeze | show PKG")
        return 0
    if args[0] in ("-V", "--version"):
        print("pip (micropip " + getattr(micropip, "__version__", "") + " on Pyodide)")
        return 0
    command, rest = args[0], args[1:]
    if command == "install":
        reqs, deps, pre, index, quiet, i = [], True, False, None, False, 0
        while i < len(rest):
            arg = rest[i]
            if arg in ("-r", "--requirement") or arg.startswith("--requirement="):
                if "=" in arg:
                    path = arg.split("=", 1)[1]
                else:
                    i += 1
                    path = rest[i]
                for line in open(path).read().splitlines():
                    line = line.split("#", 1)[0].strip()
                    if line and not line.startswith("-"):
                        reqs.append(line)
            elif arg in ("-i", "--index-url"):
                i += 1
                index = rest[i]
            elif arg.startswith("--index-url="):
                index = arg.split("=", 1)[1]
            elif arg == "--no-deps":
                deps = False
            elif arg == "--pre":
                pre = True
            elif arg in ("-q", "--quiet", "-qq", "-qqq"):
                quiet = True
            elif not arg.startswith("-"):
                reqs.append("emfs:" + os.path.abspath(arg) if arg.endswith(".whl") and os.path.exists(arg) else arg)
            i += 1
        if not reqs:
            print("ERROR: You must give at least one requirement to install", file=sys.stderr)
            return 1
        before = {name: package.version for name, package in micropip.list().items()}
        try:
            await micropip.install(reqs, deps=deps, pre=pre, index_urls=index)
        except Exception as error:
            print("ERROR: " + str(error), file=sys.stderr)
            return 1
        added = sorted(name + "-" + package.version for name, package in micropip.list().items() if before.get(name) != package.version)
        if not quiet:
            print("Successfully installed " + " ".join(added) if added else "Requirement already satisfied: " + " ".join(reqs))
        return 0
    if command == "uninstall":
        installed = micropip.list()
        for name in [arg for arg in rest if not arg.startswith("-")]:
            if name not in installed:
                print("WARNING: Skipping " + name + " as it is not installed.", file=sys.stderr)
                continue
            micropip.uninstall(name)
            print("Successfully uninstalled " + name + "-" + installed[name].version)
        return 0
    if command in ("list", "freeze"):
        packages = sorted(micropip.list().items(), key=lambda item: item[0].lower())
        if command == "freeze":
            for name, package in packages:
                print(name + "==" + package.version)
            return 0
        width = max([len("Package")] + [len(name) for name, _ in packages])
        print("Package".ljust(width) + " Version")
        print("-" * width + " -------")
        for name, package in packages:
            print(name.ljust(width) + " " + package.version)
        return 0
    if command == "show":
        from importlib import metadata
        status = 0
        for name in [arg for arg in rest if not arg.startswith("-")]:
            try:
                meta = metadata.metadata(name)
            except metadata.PackageNotFoundError:
                print("WARNING: Package(s) not found: " + name, file=sys.stderr)
                status = 1
                continue
            for key in ("Name", "Version", "Summary", "Home-page", "Author", "License"):
                print(key + ": " + (meta.get(key) or ""))
            print("Requires: " + ", ".join(metadata.requires(name) or []))
        return status
    print("ERROR: unknown command " + repr(command) + " (supported: install, uninstall, list, freeze, show)", file=sys.stderr)
    return 1

_task = None

def start(request):
    global _task
    _task = asyncio.ensure_future(run(request))
    return _task

def cancel():
    if _task is not None and not _task.done():
        _task.cancel()

async def run(request):
    global _active
    request = json.loads(request)
    kind, target, filename = request["kind"], request["target"], request["filename"]
    os.chdir(request["cwd"])
    os.environ.clear()
    os.environ.update(request["env"])
    sys.argv = request["argv"]
    sys.path[0] = request["path0"]
    _streams()
    previous = sys.modules.get("__main__")
    main = types.ModuleType("__main__")
    main.__dict__["__builtins__"] = __builtins__
    if kind == "file":
        main.__file__ = filename
    status = 0
    try:
        _active = True
        if kind == "pip":
            status = await _pip(request["argv"])
        elif kind == "module":
            import runpy
            runpy.run_module(target, run_name="__main__", alter_sys=True)
        else:
            sys.modules["__main__"] = main
            await eval_code_async(target, main.__dict__, return_mode="none", filename=filename, dedent=False)
    except (Interrupted, asyncio.CancelledError):
        status = -1
    except SystemExit as error:
        status = _status(error)
    except KeyboardInterrupt:
        print("KeyboardInterrupt", file=sys.stderr)
        status = 130
    except BaseException as error:
        _report(error)
        status = 1
    finally:
        _active = False
        for stream in (sys.stdout, sys.stderr, sys.stdin):
            try:
                stream.close()
            except Exception:
                pass
        if previous is not None:
            sys.modules["__main__"] = previous
        for name, module in list(sys.modules.items()):
            path = getattr(module, "__file__", None)
            if name not in _base and name != "__main__" and isinstance(path, str) and not path.startswith("/lib/"):
                del sys.modules[name]
    return status
`;

let compiles: boolean | undefined;

const instances = new WeakMap<object, Promise<Instance>>();

const defaultKey = {};

function canCompile(): boolean {
  if (compiles !== undefined) return compiles;
  try {
    new (WebAssembly as unknown as { Module: new (bytes: Uint8Array) => unknown }).Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    compiles = true;
  } catch {
    compiles = false;
  }
  return compiles;
}

function inNode(): boolean {
  return typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string";
}

function requireFromCwd(specifier: string): { loadPyodide?: (config: Record<string, unknown>) => Promise<Pyodide> } | undefined {
  const process = (globalThis as { process?: { cwd?: () => string; getBuiltinModule?: (id: string) => unknown } }).process;
  const builtin = process?.getBuiltinModule?.("node:module") as { createRequire?: (path: string) => (id: string) => unknown } | undefined;
  if (!builtin?.createRequire || !process?.cwd) return undefined;
  try {
    return builtin.createRequire(process.cwd() + "/package.json")(specifier) as { loadPyodide?: (config: Record<string, unknown>) => Promise<Pyodide> };
  } catch {
    return undefined;
  }
}

function packageCacheDir(): string {
  const process = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const os = process?.getBuiltinModule?.("node:os") as { tmpdir?: () => string } | undefined;
  return (os?.tmpdir?.() ?? "/tmp") + "/nanocode-pyodide-" + PYODIDE_VERSION;
}

async function loadDefault(options: PythonOptions): Promise<Pyodide> {
  const index = options.indexURL ?? PYODIDE_URL;
  const candidates = inNode() && !options.indexURL ? ["pyodide"] : [index + "pyodide.mjs"];
  const errors: string[] = [];
  for (const specifier of candidates) {
    let module: { loadPyodide?: (config: Record<string, unknown>) => Promise<Pyodide> };
    try {
      module = await import(specifier).catch((error: unknown) => {
        if (specifier === "pyodide") throw error;
        return (new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof module>)(specifier);
      });
    } catch (error) {
      const required = specifier === "pyodide" ? requireFromCwd(specifier) : undefined;
      if (!required) {
        errors.push(specifier + ": " + (error instanceof Error ? error.message : String(error)));
        continue;
      }
      module = required;
    }
    if (typeof module.loadPyodide !== "function") {
      errors.push(specifier + " has no loadPyodide export");
      continue;
    }
    return module.loadPyodide(specifier === "pyodide" ? { packageCacheDir: packageCacheDir(), stdout: () => {}, stderr: () => {} } : { indexURL: index, stdout: () => {}, stderr: () => {} });
  }
  throw new CommandError("cannot load Pyodide" + (inNode() ? " (install the pyodide npm package or set BashOptions.python.load)" : "") + ": " + errors.join("; "), 127);
}

function instance(options: PythonOptions): Promise<Instance> {
  const key = options.load ?? (options.indexURL ? options : defaultKey);
  const cached = instances.get(key);
  if (cached) return cached;
  const created = (async () => {
    const pyodide = await (options.load ? options.load() : loadDefault(options));
    const namespace = (pyodide.globals.get("dict") as () => { get(name: string): unknown })();
    pyodide.runPython(HELPER, { globals: namespace });
    const start = namespace.get("start") as (request: string) => PromiseLike<unknown>;
    const cancel = namespace.get("cancel") as () => unknown;
    return { pyodide, start, cancel, mirrored: new Set<string>(), queue: Promise.resolve(), micropip: false };
  })();
  instances.set(key, created);
  created.catch(() => instances.delete(key));
  return created;
}

const SHIPPED: readonly (readonly [string, RegExp])[] = [
  ["matplotlib", /\b(matplotlib|pyplot|plt|chart|charts|plot|plots|graph)\b/],
  ["networkx", /\bnetworkx\b/],
  ["numpy", /\b(numpy|np)\b/],
  ["pandas", /\b(pandas|dataframe|pd)\b/],
  ["pillow", /\b(pillow|pil)\b/],
  ["scikit-learn", /\b(scikit-learn|sklearn)\b/],
  ["scipy", /\bscipy\b/],
  ["sympy", /\bsympy\b/],
];

export function pythonHint(text: string): readonly string[] | undefined {
  const lower = text.toLowerCase();
  const named = SHIPPED.filter(entry => entry[0] !== "matplotlib" && entry[1].test(lower));
  if (!named.length && !/\b(python3?|pip3?|pyodide|py)\b|\.py\b/.test(lower)) return undefined;
  return SHIPPED.filter(entry => entry[1].test(lower)).map(entry => entry[0]);
}

const preloaded = new WeakMap<Instance, Set<string>>();

function threaded(options: PythonOptions): boolean {
  return options.worker !== false && !options.load && !options.indexURL && pythonWorkers();
}

const warmed = new Set<string>();

export function preloadPython(options: PythonOptions = {}, packages: readonly string[] = []): Promise<void> {
  if (!canCompile()) return Promise.resolve();
  if (threaded(options)) {
    const fresh = packages.filter(name => !warmed.has(name));
    for (const name of fresh) warmed.add(name);
    return workerPreload(HELPER, packageCacheDir(), fresh).catch(() => {});
  }
  return instance(options).then(async python => {
    const loaded = preloaded.get(python) ?? new Set<string>();
    preloaded.set(python, loaded);
    const fresh = packages.filter(name => !loaded.has(name));
    for (const name of fresh) loaded.add(name);
    if (fresh.length) await python.pyodide.loadPackage(fresh, { messageCallback: () => {}, errorCallback: () => {} });
  }).catch(() => {});
}

function reserved(path: string): boolean {
  return RESERVED.some(prefix => path === prefix || path.startsWith(prefix + "/"));
}

function join(base: string, name: string): string {
  return base === "/" ? "/" + name : base + "/" + name;
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir === "/" ? "/" : dir + "/");
}

async function snapshot(fs: FileSystem, roots: string[], maxBytes: number, maxFiles: number): Promise<Snapshot> {
  const result: Snapshot = { files: new Map(), dirs: new Set(), partial: new Set(), bytes: 0, entries: 0, left: 0, leftBytes: 0 };
  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index];
    if (reserved(path) || result.files.has(path) || result.dirs.has(path)) continue;
    await breathe();
    const stat = await fs.stat(path);
    if (!stat) continue;
    if (result.entries >= maxFiles || (stat.kind === "file" && result.bytes + stat.size > maxBytes)) {
      result.partial.add(stat.kind === "file" ? parentOf(path) : path);
      if (stat.kind === "file") {
        result.left++;
        result.leftBytes += stat.size;
      }
      continue;
    }
    result.entries++;
    if (stat.kind === "file") {
      const data = await fs.read(path);
      result.bytes += data.length;
      result.files.set(path, data);
      continue;
    }
    result.dirs.add(path);
    for (const name of await fs.list(path)) queue.push(join(path, name));
  }
  return result;
}

function unmirror(fs: PyodideFS, path: string): void {
  if (reserved(path) || !fs.analyzePath(path).exists) return;
  if (!fs.isDir(fs.stat(path).mode)) {
    fs.unlink(path);
    return;
  }
  for (const name of fs.readdir(path)) if (name !== "." && name !== "..") unmirror(fs, join(path, name));
  if (path !== "/" && !RESERVED.some(prefix => within(prefix, path))) fs.rmdir(path);
}

function mirror(fs: PyodideFS, snap: Snapshot): void {
  for (const dir of snap.dirs) fs.mkdirTree(dir);
  for (const [path, data] of snap.files) {
    fs.mkdirTree(parentOf(path));
    fs.writeFile(path, data);
  }
}

function collect(fs: PyodideFS, roots: string[]): Tree {
  const tree: Tree = { files: new Map(), dirs: new Set() };
  const visit = (path: string) => {
    if (reserved(path) || tree.files.has(path) || tree.dirs.has(path) || !fs.analyzePath(path).exists) return;
    const mode = fs.stat(path).mode;
    if (fs.isFile(mode)) tree.files.set(path, fs.readFile(path));
    if (!fs.isDir(mode)) return;
    tree.dirs.add(path);
    for (const name of fs.readdir(path)) if (name !== "." && name !== "..") visit(join(path, name));
  };
  for (const root of roots) visit(root);
  return tree;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function writeBack(fs: FileSystem, snap: Snapshot, after: Tree): Promise<void> {
  const partial = (path: string) => [...snap.partial].some(dir => within(dir, path));
  const removals = [...snap.files.keys(), ...snap.dirs].filter(path => !after.files.has(path) && !after.dirs.has(path)).sort((a, b) => b.length - a.length);
  for (const path of removals) {
    if (snap.dirs.has(path) && partial(path)) continue;
    await fs.remove(path).catch(error => {
      if (!(error instanceof FsError)) throw error;
    });
  }
  for (const dir of [...after.dirs].sort()) if (!snap.dirs.has(dir)) await mkdirs(fs, dir);
  for (const [path, data] of after.files) {
    const before = snap.files.get(path);
    if (before && same(before, data)) continue;
    await breathe();
    await mkdirs(fs, parentOf(path));
    await fs.write(path, data);
  }
}

function usage(name: string): string {
  return "usage: " + name + " [-c CMD | -m MOD | FILE | -] [ARGS...]";
}

function parse(ctx: CommandContext, args: string[]): Mode | "help" | "version" {
  if (ctx.name === "pip" || ctx.name === "pip3") return { kind: "pip", target: "", argv: args, filename: "" };
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") break;
    if (/^-[cm]./.test(arg)) return parse(ctx, [...args.slice(0, i), arg.slice(0, 2), arg.slice(2), ...args.slice(i + 1)]);
    if (arg === "-c" || arg === "-m") {
      const value = args[i + 1];
      if (value === undefined) throw new CommandError("Argument expected for the " + arg + " option\n" + usage(ctx.name), 2);
      const rest = args.slice(i + 2);
      if (arg === "-c") return { kind: "code", target: value, argv: ["-c", ...rest], filename: "<string>" };
      if (value === "pip" || value === "pip3") return { kind: "pip", target: "", argv: rest, filename: "" };
      if (value === "venv" || value === "virtualenv") throw new CommandError("-m " + value + " is not available: pip install puts packages straight into this interpreter", 1);
      return { kind: "module", target: value, argv: [value, ...rest], filename: value };
    }
    if (arg === "-V" || arg === "--version") return "version";
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "-W" || arg === "-X") {
      i++;
      continue;
    }
    if (/^-[uBEsSIOqbdRPW]+$/.test(arg) || /^-[WX]./.test(arg)) continue;
    throw new CommandError("unsupported option " + arg + "\n" + usage(ctx.name), 2);
  }
  const file = args[i];
  if (file === undefined || file === "-") return { kind: "stdin", target: "", argv: [file ?? "", ...args.slice(i + 1)], filename: "<stdin>" };
  return { kind: "file", target: "", argv: args.slice(i), filename: ctx.resolve(file) };
}

export function pythonCommands(options: PythonOptions = {}): Record<string, CommandHandler> {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 20_000;
  const mirror: Mirror = { id: crypto.randomUUID(), known: new Map() };
  const handler: CommandHandler = async ctx => {
    const mode = parse(ctx, ctx.args.slice());
    if (mode === "help") {
      ctx.stdout.write(usage(ctx.name) + "\nPython on Pyodide " + PYODIDE_VERSION + " (CPython for WebAssembly), with pip install through micropip\n");
      return 0;
    }
    if (options.remote) return executeRemote(ctx, options.remote, mode, maxBytes, maxFiles, mirror, options.batchBytes ?? 6 * 1024 * 1024);
    if (!canCompile()) {
      ctx.stderr.write(NO_WASM + "\n");
      return 126;
    }
    if (mode !== "version" && mode.kind === "file") {
      const stat = await ctx.fs.stat(mode.filename);
      if (!stat || stat.kind !== "file") {
        ctx.stderr.write(ctx.name + ": can't open file '" + mode.filename + "': [Errno " + (stat ? "21] Is a directory" : "2] No such file or directory") + "\n");
        return 2;
      }
    }
    const stdin = ctx.stdin.read();
    if (threaded(options)) return executeThreaded(ctx, mode, stdin, maxBytes, maxFiles);
    const python = await instance(options);
    const task = python.queue.then(() => execute(ctx, python, mode, stdin, maxBytes, maxFiles));
    python.queue = task.catch(() => {});
    return task;
  };
  return { pip: handler, pip3: handler, python: handler, python3: handler };
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}

function unbase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function scan(fs: FileSystem, roots: string[], maxBytes: number, maxFiles: number, maxFileBytes: number): Promise<Listing> {
  const result: Listing = { files: new Map(), dirs: new Set(), partial: new Set(), bytes: 0, left: 0, leftBytes: 0 };
  const queue = [...roots];
  let entries = 0;
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index];
    if (reserved(path) || result.files.has(path) || result.dirs.has(path)) continue;
    if (index % 256 === 0) await breathe();
    const stat = await fs.stat(path);
    if (!stat) continue;
    if (stat.kind === "file" && (entries >= maxFiles || result.bytes + stat.size > maxBytes || stat.size > maxFileBytes)) {
      result.partial.add(parentOf(path));
      result.left++;
      result.leftBytes += stat.size;
      continue;
    }
    if (stat.kind !== "file" && entries >= maxFiles) {
      result.partial.add(path);
      continue;
    }
    entries++;
    if (stat.kind === "file") {
      result.bytes += stat.size;
      result.files.set(path, stat.size + ":" + stat.mtime);
      continue;
    }
    result.dirs.add(path);
    for (const name of await fs.list(path)) queue.push(join(path, name));
  }
  return result;
}

function leftOut(ctx: CommandContext, left: number, bytes: number, partial: Set<string>, limit: string): void {
  if (!left && !partial.size) return;
  const where = [...partial].sort().slice(0, 3).join(", ");
  ctx.stderr.write(ctx.name + ": warning: Python cannot see " + (left ? left + " file" + (left === 1 ? "" : "s") + " (" + (bytes / 1024 / 1024).toFixed(1) + " MiB) " : "some files ") + "under " + where + (partial.size > 3 ? " and " + (partial.size - 3) + " more directories" : "") + ", past " + limit + "; cd into the directory the script needs, or move large files out of it\n");
}

async function executeRemote(ctx: CommandContext, remote: PythonRemote, mode: Mode | "version", maxBytes: number, maxFiles: number, mirror: Mirror, batchBytes: number): Promise<number> {
  const stdin = ctx.stdin.read();
  const kind = mode === "version" ? "version" : mode.kind;
  const roots = mode === "version" ? [] : [ctx.cwd, "/tmp", ...(mode.kind === "file" ? [mode.filename] : [])].filter(root => !reserved(root));
  const unique = roots.filter((root, index) => roots.indexOf(root) === index && !roots.some(other => other !== root && within(root, other)));
  const tree = await scan(ctx.fs, unique, maxBytes, maxFiles, maxBytes);
  if (ctx.signal.aborted) throw new CommandError("interrupted", 130);
  const target = mode === "version" ? "" : mode.kind === "file" ? "" : mode.kind === "stdin" ? stdin : mode.target;
  const base = { name: ctx.name, cwd: ctx.cwd, env: { ...ctx.env, PWD: ctx.cwd }, roots: unique, dirs: [...tree.dirs], timeoutMs: ctx.limits.timeoutMs, mirror: mirror.id };
  const call = async (request: PythonRequest): Promise<PythonReply> => {
    try {
      return await remote(request, ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted) throw new CommandError("interrupted", 130);
      throw new CommandError(ctx.name + ": " + (error instanceof Error ? error.message : String(error)), 127);
    }
  };
  const control = { ...base, kind: "version" as const, target: "", argv: [], filename: "", stdin: "", keep: [] };
  const upload = async (paths: string[]): Promise<[string, string][]> => {
    let batch: [string, string][] = [];
    let bytes = 0;
    for (const path of paths) {
      const data = await ctx.fs.read(path).catch(() => null);
      if (!data) continue;
      if (data.length > batchBytes) {
        for (let offset = 0; offset < data.length; offset += batchBytes) {
          const reply = await call({ ...control, files: [[path, base64(data.subarray(offset, offset + batchBytes))]], sync: true, append: offset > 0 });
          if (reply.mirror !== mirror.id) throw new CommandError(ctx.name + ": " + path + " is larger than one upload and the Python service does not keep files between runs; move it out of this directory", 127);
        }
        mirror.known.set(path, tree.files.get(path)!);
        continue;
      }
      if (batch.length && bytes + data.length > batchBytes) {
        const reply = await call({ ...control, files: batch, sync: true });
        if (reply.mirror !== mirror.id) throw new CommandError(ctx.name + ": this directory holds more than one upload and the Python service does not keep files between runs; run python3 from a smaller directory", 127);
        for (const [sent] of batch) mirror.known.set(sent, tree.files.get(sent)!);
        batch = [];
        bytes = 0;
      }
      batch.push([path, base64(data)]);
      bytes += data.length;
    }
    return batch;
  };
  let pending = [...tree.files.keys()].filter(path => mirror.known.get(path) !== tree.files.get(path));
  let reply: PythonReply | undefined;
  for (let attempt = 0; ; attempt++) {
    const files = await upload(pending);
    const sent = new Set(files.map(([path]) => path));
    const keep = [...tree.files.keys()].filter(path => !sent.has(path) && mirror.known.get(path) === tree.files.get(path));
    reply = await call({ ...base, kind, target, argv: mode === "version" ? [] : mode.argv, filename: mode === "version" ? "" : mode.filename, files, keep, stdin: mode !== "version" && mode.kind === "stdin" ? "" : stdin });
    if (!reply.missing?.length || attempt >= 2) break;
    for (const path of reply.missing) mirror.known.delete(path);
    for (const [path] of files) mirror.known.set(path, tree.files.get(path)!);
    pending = reply.missing.filter(path => tree.files.has(path));
  }
  if (reply.mirror !== mirror.id) mirror.known.clear();
  if (reply.missing?.length) throw new CommandError(ctx.name + ": the Python service kept losing this workspace's files; try again", 127);
  leftOut(ctx, tree.left, tree.leftBytes, tree.partial, "the " + (maxBytes / 1024 / 1024).toFixed(0) + " MiB or " + maxFiles + "-file limit for Python");
  if (reply.stdout) ctx.stdout.write(reply.stdout);
  if (reply.stderr) ctx.stderr.write(reply.stderr);
  if (unique.length) {
    const changed = new Map<string, string>();
    const large = new Map(reply.large ?? []);
    for (const [path, data] of reply.files) if (data !== null) changed.set(path, data);
    for (let more = reply.more ?? []; more.length;) {
      const fetched = await call({ ...control, files: [], fetch: more });
      for (const [path, data] of fetched.files) if (data !== null) changed.set(path, data);
      for (const [path, size] of fetched.large ?? []) large.set(path, size);
      more = fetched.more ?? [];
      if (!fetched.files.length && !fetched.large?.length) break;
    }
    const present = new Set(reply.files.map(([path]) => path));
    const dirs = new Set(reply.dirs);
    const partial = (path: string) => [...tree.partial].some(dir => within(dir, path));
    const removals = [...tree.files.keys(), ...tree.dirs].filter(path => !present.has(path) && !dirs.has(path)).sort((a, b) => b.length - a.length);
    for (const path of removals) {
      if (tree.dirs.has(path) && (partial(path) || dirs.has(path))) continue;
      mirror.known.delete(path);
      await ctx.fs.remove(path).catch(error => {
        if (!(error instanceof FsError)) throw error;
      });
    }
    for (const dir of [...dirs].sort()) if (!tree.dirs.has(dir)) await mkdirs(ctx.fs, dir);
    for (const [path, data] of reply.files) {
      if (data !== null || !tree.files.has(path)) continue;
      if (reply.mirror === mirror.id) mirror.known.set(path, tree.files.get(path)!);
    }
    for (const [path, data] of changed) {
      await breathe();
      await mkdirs(ctx.fs, parentOf(path));
      await ctx.fs.write(path, unbase64(data));
      const stat = await ctx.fs.stat(path);
      if (stat && reply.mirror === mirror.id) mirror.known.set(path, stat.size + ":" + stat.mtime);
    }
    for (const [path, size] of large) {
      await mkdirs(ctx.fs, parentOf(path));
      try {
        for (let offset = 0; offset < size || offset === 0; offset += batchBytes) {
          const piece = await call({ ...control, files: [], fetch: [path], range: [offset, batchBytes] });
          const data = piece.files[0]?.[1];
          if (data == null) throw new CommandError(ctx.name + ": " + path + " changed while it was copied back", 127);
          await ctx.fs.write(path, unbase64(data), offset > 0);
          if (offset + batchBytes >= size) break;
        }
      } catch (error) {
        if (!(error instanceof FsError)) throw error;
        await ctx.fs.remove(path).catch(() => {});
        mirror.known.delete(path);
        ctx.stderr.write(ctx.name + ": warning: " + path + " (" + (size / 1024 / 1024).toFixed(1) + " MiB) stays in the Python container: " + error.message + "\n");
        continue;
      }
      const stat = await ctx.fs.stat(path);
      if (stat && reply.mirror === mirror.id) mirror.known.set(path, stat.size + ":" + stat.mtime);
    }
  }
  if (reply.status >= 0) return reply.status;
  if (ctx.signal.aborted) throw new CommandError("interrupted", 130);
  throw new CommandError("timed out after " + ctx.limits.timeoutMs + " ms", 124);
}


async function executeThreaded(ctx: CommandContext, mode: Mode | "version", stdin: string, maxBytes: number, maxFiles: number): Promise<number> {
  if (mode === "version") {
    ctx.stdout.write("Python " + await workerVersion(HELPER, packageCacheDir()) + "\n");
    return 0;
  }
  const roots = [ctx.cwd, "/tmp", ...(mode.kind === "file" ? [mode.filename] : [])].filter(root => !reserved(root));
  const unique = roots.filter((root, index) => roots.indexOf(root) === index && !roots.some(other => other !== root && within(root, other)));
  const snap = await snapshot(ctx.fs, unique, maxBytes, maxFiles);
  leftOut(ctx, snap.left, snap.leftBytes, snap.partial, "the " + (maxBytes / 1024 / 1024).toFixed(0) + " MiB or " + maxFiles + "-file limit for Python");
  const target = mode.kind === "stdin" ? stdin : mode.kind === "file" ? new TextDecoder().decode(snap.files.get(mode.filename) ?? (await ctx.fs.read(mode.filename))) : mode.target;
  if (ctx.signal.aborted) throw new CommandError("interrupted", 130);
  const env = { ...ctx.env, PWD: ctx.cwd, PYTHONDONTWRITEBYTECODE: "1" };
  const path0 = mode.kind === "file" ? parentOf(mode.filename) : mode.kind === "module" ? ctx.cwd : "";
  const done = await workerRun(HELPER, packageCacheDir(), ctx, { kind: mode.kind, name: ctx.name, target, argv: mode.argv, filename: mode.filename, cwd: ctx.cwd, env, path0, roots: unique, dirs: [...snap.dirs], files: [...snap.files], stdin: encode(mode.kind === "stdin" ? "" : stdin) });
  await writeBack(ctx.fs, snap, done.tree);
  if (done.failure !== undefined) throw done.failure;
  if (done.status >= 0) return done.status;
  if (ctx.signal.aborted) throw new CommandError("interrupted", 130);
  throw new CommandError("timed out after " + ctx.limits.timeoutMs + " ms", 124);
}

async function execute(ctx: CommandContext, python: Instance, mode: Mode | "version", stdin: string, maxBytes: number, maxFiles: number): Promise<number> {
  const pyodide = python.pyodide;
  if (mode === "version") {
    ctx.stdout.write("Python " + String(pyodide.runPython("import sys; sys.version.split()[0]")) + "\n");
    return 0;
  }

  const roots = [ctx.cwd, "/tmp", ...(mode.kind === "file" ? [mode.filename] : [])].filter(root => !reserved(root));
  const unique = roots.filter((root, index) => roots.indexOf(root) === index && !roots.some(other => other !== root && within(root, other)));
  pyodide.FS.chdir("/");
  for (const path of python.mirrored) unmirror(pyodide.FS, path);
  python.mirrored = new Set(unique);
  const snap = await snapshot(ctx.fs, unique, Math.min(maxBytes, Math.floor(ctx.limits.maxMemoryBytes / 2)), maxFiles);
  leftOut(ctx, snap.left, snap.leftBytes, snap.partial, "the " + (Math.min(maxBytes, Math.floor(ctx.limits.maxMemoryBytes / 2)) / 1024 / 1024).toFixed(0) + " MiB or " + maxFiles + "-file limit for Python");
  mirror(pyodide.FS, snap);
  pyodide.FS.mkdirTree(ctx.cwd);

  const messages = { messageCallback: () => {}, errorCallback: (message: string) => ctx.stderr.write(message + "\n") };
  if (mode.kind === "stdin") mode.target = stdin;
  if (mode.kind === "file") mode.target = new TextDecoder().decode(snap.files.get(mode.filename) ?? (await ctx.fs.read(mode.filename)));
  try {
    if (mode.kind === "pip" && !python.micropip) {
      await pyodide.loadPackage("micropip", messages);
      python.micropip = true;
    }
    if (mode.kind === "module") await pyodide.loadPackagesFromImports("import " + mode.target, messages);
    else if (mode.kind !== "pip") await pyodide.loadPackagesFromImports(mode.target, messages);
  } catch (error) {
    ctx.stderr.write(ctx.name + ": " + (error instanceof Error ? error.message : String(error)) + "\n");
  }

  if (ctx.signal.aborted) throw new CommandError("interrupted", 130);
  const deadline = Date.now() + ctx.limits.timeoutMs;
  let failure: unknown;
  let quiet = false;
  let signalled = 0;
  const stopped = () => !quiet && (failure !== undefined || ctx.signal.aborted || Date.now() > deadline);
  const input = encode(mode.kind === "stdin" ? "" : stdin);
  let offset = 0;
  const sink = (target: CommandContext["stdout"]) => {
    return {
      isatty: false,
      flush: () => undefined,
      write(buffer: Uint8Array) {
        try {
          target.write(decode(buffer));
        } catch (error) {
          failure ??= error;
        }
        return buffer.length;
      },
    };
  };
  const stdout = sink(ctx.stdout);
  const stderr = sink(ctx.stderr);
  pyodide.setStdin({
    isatty: false,
    read(buffer) {
      const count = Math.min(buffer.length, input.length - offset);
      buffer.set(input.subarray(offset, offset + count));
      offset += count;
      return count;
    },
  });
  pyodide.setStdout(stdout);
  pyodide.setStderr(stderr);
  pyodide.setInterruptBuffer({
    get 0() {
      if (!stopped() || Date.now() - signalled < 50) return 0;
      signalled = Date.now();
      return 2;
    },
    set 0(_value: number) {},
  });

  const env = { ...ctx.env, PWD: ctx.cwd, PYTHONDONTWRITEBYTECODE: "1" };
  const path0 = mode.kind === "file" ? parentOf(mode.filename) : mode.kind === "module" ? ctx.cwd : "";
  const task = python.start(JSON.stringify({ kind: mode.kind, target: mode.target, argv: mode.argv, filename: mode.filename, cwd: ctx.cwd, env, path0 }));
  const cancel = () => {
    quiet = true;
    try {
      python.cancel();
    } catch {}
    quiet = false;
  };
  const timer = setTimeout(cancel, Math.max(0, deadline - Date.now()));
  ctx.signal.addEventListener("abort", cancel, { once: true });
  let status: number;
  try {
    status = Number(await task);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", cancel);
    pyodide.setInterruptBuffer(undefined);
    stdout.flush();
    stderr.flush();
  }

  await writeBack(ctx.fs, snap, collect(pyodide.FS, unique));
  if (failure !== undefined) throw failure;
  if (status >= 0) return status;
  if (ctx.signal.aborted && Date.now() <= deadline) throw new CommandError("interrupted", 130);
  throw new CommandError("timed out after " + ctx.limits.timeoutMs + " ms", 124);
}
