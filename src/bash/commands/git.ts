import { CommandError, type CommandContext, type CommandHandler } from "../shell.ts";
import { breathe, decode, encode, FsError, normalize, parentOf, type FileSystem } from "../fs.ts";
import { TarReader } from "./archive.ts";
import { guarded, mark } from "../../egress.ts";

const MAX_BYTES = 200 * 1024 * 1024;

const MAX_FILE_BYTES = 8 * 1024 * 1024;

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const MAX_FILES = 50_000;

const STALL_MS = 30_000;

const ATTEMPTS = 2;

const MARKER = ".git/nanocode.json";

const SUPPORTED = "clone, status, log, show, rev-parse, branch, remote, ls-files, describe";

type Snapshot = {
  repository: string;
  url: string;
  ref: string;
  branch: string | null;
  commit: string | null;
  author: string | null;
  date: string | null;
  message: string | null;
  cloned: string;
  files: Record<string, [number, number]>;
  omitted?: string[];
};

export type GitHubOptions = { archive?(owner: string, repo: string, ref: string): string; details?: boolean; token?: GitHubToken; maxBytes?: number; maxFiles?: number; maxFileBytes?: number; maxDownloadBytes?: number; stallMs?: number };

type Clone = { repository: string; ref: string | undefined; directory: string | undefined; quiet: boolean };

const NAME = /^[A-Za-z0-9_.-]+$/;

export function repositoryOf(spec: string): string | null {
  const patterns = [
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^(?:github\.com\/)?([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(spec);
    if (match && NAME.test(match[1]) && NAME.test(match[2])) return match[1] + "/" + match[2];
  }
  return null;
}

function parseClone(args: string[]): Clone {
  const operands: string[] = [];
  let ref: string | undefined;
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = (name: string) => {
      const eq = arg.indexOf("=");
      if (eq > 0) return arg.slice(eq + 1);
      const next = args[++i];
      if (next === undefined) throw new CommandError("fatal: option '" + name + "' requires a value", 129);
      return next;
    };
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-b" || arg === "--branch" || arg.startsWith("--branch=")) ref = value("branch");
    else if (arg === "--depth" || arg.startsWith("--depth=") || arg === "--filter" || arg.startsWith("--filter=") || arg === "--origin" || arg.startsWith("--origin=") || arg === "-o" || arg === "--shallow-since" || arg.startsWith("--shallow-since=") || arg === "-c" || arg === "--config" || arg.startsWith("--config=") || arg === "-j" || arg === "--jobs" || arg.startsWith("--jobs=")) value(arg);
    else if (arg === "-q" || arg === "--quiet") quiet = true;
    else if (arg.startsWith("--depth") || ["--single-branch", "--no-single-branch", "--recursive", "--recurse-submodules", "--shallow-submodules", "--no-tags", "--progress", "-v", "--verbose", "--no-checkout", "-n", "--bare", "--mirror", "--no-hardlinks", "-l", "--local"].includes(arg)) continue;
    else if (arg.startsWith("-")) throw new CommandError("error: unknown option '" + arg.replace(/^-+/, "") + "'", 129);
    else operands.push(arg);
  }
  if (!operands.length) throw new CommandError("fatal: You must specify a repository to clone.", 129);
  if (operands.length > 2) throw new CommandError("fatal: Too many arguments.", 129);
  const repository = repositoryOf(operands[0]);
  if (!repository) throw new CommandError("fatal: only GitHub repositories can be cloned here (https://github.com/OWNER/REPO, git@github.com:OWNER/REPO.git or OWNER/REPO): " + operands[0], 128);
  return { repository, ref, directory: operands[1], quiet };
}

export function codeload(owner: string, repo: string, ref: string): string {
  return "https://codeload.github.com/" + owner + "/" + repo + "/tar.gz/" + ref.split("/").map(encodeURIComponent).join("/");
}

class Stalled extends Error {}

type Watch = { signal: AbortSignal; arm(): void; stop(): void; race<T>(promise: Promise<T>): Promise<T> };

function watchdog(parent: AbortSignal, ms: number, what: string): Watch {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail: (error: Error) => void = () => {};
  const stalled = new Promise<never>((_, reject) => {
    fail = reject;
  });
  stalled.catch(() => {});
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    arm() {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        const error = new Stalled(what + " sent no data for " + Math.round(ms / 1000) + " s");
        controller.abort(error);
        fail(error);
      }, ms);
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer);
    },
    race: promise => Promise.race([promise, stalled]),
  };
}

function lost(error: unknown): boolean {
  return error instanceof Stalled || (error instanceof Error && !(error instanceof CommandError) && /network connection lost|connection (?:was )?(?:reset|closed|lost)|terminated|socket hang up|ECONNRESET|other side closed/i.test(error.message));
}

async function fetchArchive(ctx: CommandContext, github: GitHubOptions, repository: string, ref: string): Promise<{ response: Response; watch: Watch }> {
  if (!ctx.fetch) throw new CommandError("fatal: network access is not available in this shell", 128);
  const fetcher = withGitHub(ctx.fetch, { token: github.token });
  const [owner, repo] = repository.split("/");
  const urls = github.archive ? [github.archive(owner, repo, ref)] : [codeload(owner, repo, ref), "https://api.github.com/repos/" + repository + "/tarball/" + encodeURIComponent(ref)];
  const stallMs = github.stallMs ?? STALL_MS;
  let last = 0;
  for (const url of urls) {
    const watch = watchdog(ctx.signal, stallMs, "GitHub");
    let response: Response;
    try {
      watch.arm();
      response = await watch.race(fetcher(url, { signal: watch.signal, redirect: "follow" }));
    } catch (error) {
      watch.stop();
      if (ctx.signal.aborted) throw error;
      if (error instanceof Error && /network access|refused: this host/.test(error.message)) throw new CommandError("fatal: " + error.message, 128);
      last = error instanceof Stalled ? -2 : -1;
      continue;
    }
    if (response.ok && response.body) return { response, watch };
    watch.stop();
    last = response.status;
    await response.body?.cancel().catch(() => {});
  }
  if (last === 404) throw new CommandError("fatal: repository 'https://github.com/" + repository + ".git/' or ref '" + ref + "' not found (private repositories cannot be cloned here)", 128);
  if (last === -2) throw new Stalled("GitHub did not start sending the archive within " + Math.round(stallMs / 1000) + " s");
  throw new CommandError("fatal: unable to download https://github.com/" + repository + " at " + ref + (last > 0 ? " (HTTP " + last + ")" : ""), 128);
}

async function details(ctx: CommandContext, github: GitHubOptions, repository: string, ref: string, commit: string | null): Promise<{ branch: string | null; author: string | null; date: string | null; message: string | null; commit: string | null }> {
  const out = { branch: ref === "HEAD" || /^[0-9a-f]{40}$/.test(ref) ? null : ref, author: null as string | null, date: null as string | null, message: null as string | null, commit };
  if (!ctx.fetch) return out;
  const fetcher = withGitHub(ctx.fetch, { token: github.token });
  const get = async (path: string): Promise<unknown> => {
    try {
      const response = await fetcher("https://api.github.com/repos/" + repository + path, { headers: { accept: "application/vnd.github+json", "user-agent": "nanocode-ts" }, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(5000)]) });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  const [repo, info] = await Promise.all([ref === "HEAD" ? get("") : null, get("/commits/" + encodeURIComponent(commit ?? ref))]);
  const branch = (repo as { default_branch?: unknown } | null)?.default_branch;
  if (typeof branch === "string") out.branch = branch;
  const data = info as { sha?: unknown; commit?: { author?: { name?: unknown; email?: unknown; date?: unknown }; message?: unknown } } | null;
  if (typeof data?.sha === "string") out.commit = data.sha;
  const author = data?.commit?.author;
  if (typeof author?.name === "string") out.author = author.name + (typeof author.email === "string" ? " <" + author.email + ">" : "");
  if (typeof author?.date === "string") out.date = author.date;
  if (typeof data?.commit?.message === "string") out.message = data.commit.message;
  return out;
}

async function removeTree(fs: FileSystem, path: string) {
  const stat = await fs.stat(path);
  if (stat?.kind === "directory") for (const name of await fs.list(path)) await removeTree(fs, (path === "/" ? "" : path) + "/" + name);
  if (stat) await fs.remove(path);
}

async function clone(ctx: CommandContext, github: GitHubOptions, args: string[]): Promise<number> {
  const options = parseClone(args);
  const name = options.repository.split("/")[1];
  const directory = options.directory ?? name;
  const target = ctx.resolve(directory);
  const existing = await ctx.fs.stat(target);
  if (existing && (existing.kind !== "directory" || (await ctx.fs.list(target)).length)) throw new CommandError("fatal: destination path '" + directory + "' already exists and is not an empty directory.", 128);
  const ref = options.ref ?? "HEAD";
  if (!ctx.fetch) throw new CommandError("fatal: network access is not available in this shell", 128);
  if (!options.quiet) ctx.stderr.write("Cloning into '" + directory + "'...\n");
  const known = new Set<string>();
  const ensure = async (path: string) => {
    if (known.has(path)) return;
    const parent = parentOf(path);
    if (parent !== path) await ensure(parent);
    const stat = await ctx.fs.stat(path);
    if (!stat) await ctx.fs.mkdir(path);
    else if (stat.kind !== "directory") throw new FsError("ENOTDIR", path);
    known.add(path);
  };
  const maxBytes = github.maxBytes ?? MAX_BYTES;
  const maxFiles = github.maxFiles ?? MAX_FILES;
  const maxFileBytes = github.maxFileBytes ?? MAX_FILE_BYTES;
  const maxDownload = github.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  const created = !existing;
  let files: Record<string, [number, number]> = {};
  let reader = new TarReader(maxFileBytes);
  let omitted: { path: string; bytes: number; reason: string }[] = [];
  let written = 0;
  let count = 0;
  let skipped = 0;
  for (let attempt = 1; ; attempt++) {
    files = {};
    reader = new TarReader(maxFileBytes);
    omitted = [];
    written = 0;
    count = 0;
    skipped = 0;
    known.clear();
    let watch: Watch | undefined;
    let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let root: string | undefined;
    let bytes = 0;
    try {
      const download = await fetchArchive(ctx, github, options.repository, ref);
      watch = download.watch;
      stream = download.response.body!.pipeThrough(new DecompressionStream("gzip")).getReader();
      await ensure(target);
      for (;;) {
        if (ctx.signal.aborted) throw new CommandError("fatal: clone aborted", 130);
        watch.arm();
        const next = await watch.race(stream.read());
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > maxDownload) throw new CommandError("fatal: repository archive is larger than " + Math.round(maxDownload / 1024 / 1024) + " MiB uncompressed; clone a smaller repository or fetch single files with curl", 128);
        watch.stop();
        for (const entry of reader.push(next.value)) {
          const parts = entry.name.split("/");
          if (entry.name.startsWith("/") || entry.name.includes("\\") || entry.name.includes("\0") || parts.some(part => part === ".." || part === "." || part === "" || part === ".git")) throw new CommandError("fatal: repository archive contains an unsafe path: " + entry.name, 128);
          root ??= parts[0];
          if (parts[0] !== root) throw new CommandError("fatal: repository archive must contain one root directory", 128);
          if (parts.length === 1) continue;
          const relative = parts.slice(1).join("/");
          const path = target + "/" + relative;
          if (entry.type === "directory") {
            await ensure(path);
            continue;
          }
          if (entry.type !== "file") {
            skipped++;
            continue;
          }
          const reason = entry.omitted !== undefined ? "larger than " + size(maxFileBytes) : count >= maxFiles ? "past the " + maxFiles + "-file limit" : written + entry.data.length > maxBytes ? "past the " + size(maxBytes) + " limit" : undefined;
          if (reason) {
            omitted.push({ path: relative, bytes: entry.omitted ?? entry.data.length, reason });
            continue;
          }
          count++;
          written += entry.data.length;
          await breathe();
          await ensure(parentOf(path));
          try {
            await ctx.fs.write(path, entry.data);
          } catch (error) {
            if (!(error instanceof FsError) || error.code !== "EFBIG") throw error;
            omitted.push({ path: relative, bytes: entry.data.length, reason: "larger than this filesystem stores" });
            count--;
            written -= entry.data.length;
            continue;
          }
          const stat = await ctx.fs.stat(path);
          files[relative] = [entry.data.length, stat?.mtime ?? 0];
        }
        if (reader.done) break;
      }
      if (!root) throw new CommandError("fatal: repository archive is empty", 128);
      watch.stop();
      await stream.cancel().catch(() => {});
      break;
    } catch (error) {
      watch?.stop();
      await stream?.cancel().catch(() => {});
      if (created) await removeTree(ctx.fs, target).catch(() => {});
      else for (const name of await ctx.fs.list(target).catch(() => [] as string[])) await removeTree(ctx.fs, target + "/" + name).catch(() => {});
      if (!ctx.signal.aborted && lost(error)) {
        const reason = error instanceof Error ? error.message.replace(/\.$/, "") : String(error);
        if (attempt < ATTEMPTS) {
          if (!options.quiet) ctx.stderr.write("warning: the download of " + options.repository + (bytes ? " broke off after " + size(bytes) : " did not start") + " (" + reason + "); retrying\n");
          continue;
        }
        throw new CommandError("fatal: could not download https://github.com/" + options.repository + " at " + ref + ": " + reason + " (" + ATTEMPTS + " attempts); try again later, clone with -b <tag> for a smaller ref, or fetch single files with curl", 128);
      }
      if (error instanceof Error && !(error instanceof CommandError) && /exceeds the limit/.test(error.message)) throw new CommandError("fatal: " + error.message, 128);
      throw error;
    }
  }
  const pax = reader.global["comment"];
  const commit = pax && /^[0-9a-f]{40}$/.test(pax) ? pax : null;
  const info = github.details === false ? { branch: ref === "HEAD" ? null : ref, author: null, date: null, message: null, commit } : await details(ctx, github, options.repository, ref, commit);
  const snapshot: Snapshot = { repository: options.repository, url: "https://github.com/" + options.repository + ".git", ref, branch: info.branch, commit: info.commit, author: info.author, date: info.date, message: info.message, cloned: new Date().toISOString(), files, ...(omitted.length ? { omitted: omitted.map(item => item.path) } : {}) };
  await ensure(target + "/.git");
  await ctx.fs.write(target + "/.git/HEAD", encode(snapshot.branch ? "ref: refs/heads/" + snapshot.branch + "\n" : (snapshot.commit ?? ref) + "\n"));
  await ctx.fs.write(target + "/.git/config", encode("[remote \"origin\"]\n\turl = " + snapshot.url + "\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n" + (snapshot.branch ? "[branch \"" + snapshot.branch + "\"]\n\tremote = origin\n\tmerge = refs/heads/" + snapshot.branch + "\n" : "")));
  await ctx.fs.write(target + "/" + MARKER, encode(JSON.stringify(snapshot)));
  if (omitted.length) {
    const raw = "https://raw.githubusercontent.com/" + options.repository + "/" + (snapshot.commit ?? ref) + "/";
    ctx.stderr.write("warning: left out " + omitted.length + " file" + (omitted.length === 1 ? "" : "s") + " (" + size(omitted.reduce((total, item) => total + item.bytes, 0)) + "); fetch one with curl -sLO " + raw + "PATH\n");
    for (const item of omitted.slice(0, 10)) ctx.stderr.write("  " + item.path + " (" + size(item.bytes) + ", " + item.reason + ")\n");
    if (omitted.length > 10) ctx.stderr.write("  ... and " + (omitted.length - 10) + " more, listed in .git/nanocode.json\n");
  }
  if (!options.quiet) ctx.stderr.write("Downloaded " + count + " files (" + size(written) + ") from " + options.repository + " at " + (snapshot.commit ? snapshot.commit.slice(0, 7) : ref) + ": a source snapshot without history" + (skipped ? "; skipped " + skipped + " symbolic link" + (skipped === 1 ? "" : "s") : "") + ".\n");
  return 0;
}

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + " KiB" : (bytes / 1024 / 1024).toFixed(2) + " MiB";
}

async function locate(ctx: CommandContext): Promise<{ root: string; snapshot: Snapshot }> {
  let dir = ctx.cwd;
  for (;;) {
    const stat = await ctx.fs.stat((dir === "/" ? "" : dir) + "/" + MARKER);
    if (stat?.kind === "file") return { root: dir, snapshot: JSON.parse(decode(await ctx.fs.read((dir === "/" ? "" : dir) + "/" + MARKER))) as Snapshot };
    if (dir === "/") break;
    dir = parentOf(dir);
  }
  throw new CommandError("fatal: not a git repository (or any of the parent directories): .git", 128);
}

async function walk(fs: FileSystem, root: string, prefix: string, out: Map<string, { size: number; mtime: number }>) {
  for (const name of await fs.list(root + (prefix ? "/" + prefix : ""))) {
    const relative = prefix ? prefix + "/" + name : name;
    if (relative === ".git") continue;
    const stat = await fs.stat(root + "/" + relative);
    if (!stat) continue;
    if (stat.kind === "directory") await walk(fs, root, relative, out);
    else out.set(relative, { size: stat.size, mtime: stat.mtime });
  }
}

async function changes(ctx: CommandContext, root: string, snapshot: Snapshot) {
  const current = new Map<string, { size: number; mtime: number }>();
  await walk(ctx.fs, root, "", current);
  const modified: string[] = [];
  const deleted: string[] = [];
  const untracked: string[] = [];
  for (const [path, [length, mtime]] of Object.entries(snapshot.files)) {
    const now = current.get(path);
    if (!now) deleted.push(path);
    else if (now.size !== length || now.mtime !== mtime) modified.push(path);
  }
  const omitted = new Set(snapshot.omitted);
  for (const path of current.keys()) if (!Object.hasOwn(snapshot.files, path) && !omitted.has(path)) untracked.push(path);
  return { modified: modified.sort(), deleted: deleted.sort(), untracked: untracked.sort() };
}

function relativeTo(ctx: CommandContext, root: string, path: string): string {
  const absolute = normalize(root + "/" + path);
  const base = ctx.cwd === "/" ? "/" : ctx.cwd + "/";
  if (absolute.startsWith(base)) return absolute.slice(base.length);
  const up = ctx.cwd.split("/").filter(Boolean);
  const target = absolute.split("/").filter(Boolean);
  let common = 0;
  while (common < up.length && common < target.length && up[common] === target[common]) common++;
  return [...Array(up.length - common).fill(".."), ...target.slice(common)].join("/");
}

async function status(ctx: CommandContext, args: string[]): Promise<number> {
  const { root, snapshot } = await locate(ctx);
  const short = args.includes("-s") || args.includes("--short") || args.includes("--porcelain");
  const found = await changes(ctx, root, snapshot);
  const show = (path: string) => relativeTo(ctx, root, path);
  if (short) {
    for (const path of found.modified) ctx.stdout.write(" M " + show(path) + "\n");
    for (const path of found.deleted) ctx.stdout.write(" D " + show(path) + "\n");
    for (const path of found.untracked) ctx.stdout.write("?? " + show(path) + "\n");
    return 0;
  }
  ctx.stdout.write(snapshot.branch ? "On branch " + snapshot.branch + "\n" : "HEAD detached at " + (snapshot.commit?.slice(0, 7) ?? snapshot.ref) + "\n");
  if (snapshot.branch) ctx.stdout.write("Your branch is up to date with 'origin/" + snapshot.branch + "'.\n");
  if (!found.modified.length && !found.deleted.length && !found.untracked.length) {
    ctx.stdout.write("\nnothing to commit, working tree clean\n");
    return 0;
  }
  if (found.modified.length || found.deleted.length) {
    ctx.stdout.write("\nChanges not staged for commit:\n");
    for (const path of found.modified) ctx.stdout.write("\tmodified:   " + show(path) + "\n");
    for (const path of found.deleted) ctx.stdout.write("\tdeleted:    " + show(path) + "\n");
  }
  if (found.untracked.length) {
    ctx.stdout.write("\nUntracked files:\n");
    for (const path of found.untracked) ctx.stdout.write("\t" + show(path) + "\n");
  }
  ctx.stdout.write("\nno changes added to commit (this clone is a source snapshot; commits are not supported)\n");
  return 0;
}

async function log(ctx: CommandContext, args: string[]): Promise<number> {
  const { snapshot } = await locate(ctx);
  const commit = snapshot.commit ?? "0000000000000000000000000000000000000000";
  const oneline = args.includes("--oneline") || args.some(arg => arg === "--format=%H" || arg === "--pretty=%H" || arg === "--format=oneline" || arg === "--pretty=oneline");
  const subject = (snapshot.message ?? "(commit message unavailable)").split("\n")[0];
  const decoration = snapshot.branch ? " (HEAD -> " + snapshot.branch + ", origin/" + snapshot.branch + ")" : " (HEAD)";
  if (args.some(arg => arg === "--format=%H" || arg === "--pretty=%H" || arg === "--pretty=format:%H" || arg === "--format=format:%H")) {
    ctx.stdout.write(commit + "\n");
    return 0;
  }
  if (oneline) {
    ctx.stdout.write((args.includes("--oneline") ? commit.slice(0, 7) : commit) + decoration + " " + subject + "\n");
    return 0;
  }
  ctx.stdout.write("commit " + commit + decoration + "\n");
  if (snapshot.author) ctx.stdout.write("Author: " + snapshot.author + "\n");
  if (snapshot.date) ctx.stdout.write("Date:   " + new Date(snapshot.date).toUTCString() + "\n");
  ctx.stdout.write("\n" + (snapshot.message ?? "(commit message unavailable)").split("\n").map(line => "    " + line).join("\n") + "\n");
  ctx.stderr.write("(source snapshot: earlier history is not available)\n");
  return 0;
}

async function git(ctx: CommandContext, github: GitHubOptions, args: string[]): Promise<number> {
  let i = 0;
  while (i < args.length && args[i].startsWith("-") && args[i] !== "--version" && args[i] !== "--help") {
    if (args[i] === "-C") {
      const dir = args[i + 1];
      if (dir === undefined) throw new CommandError("fatal: option '-C' requires a value", 129);
      const cwd = ctx.resolve(dir);
      ctx = { ...ctx, cwd, resolve: path => normalize(path.startsWith("/") ? path : cwd + "/" + path) };
      i += 2;
    } else if (args[i] === "-c") i += 2;
    else i++;
  }
  const command = args[i];
  const rest = args.slice(i + 1);
  switch (command) {
    case "--version":
    case "version":
      ctx.stdout.write("git version 2.47.0 (nanocode snapshot git)\n");
      return 0;
    case "clone":
      return clone(ctx, github, rest);
    case "status":
      return status(ctx, rest);
    case "log":
    case "show":
      return log(ctx, rest);
    case "rev-parse": {
      const { root, snapshot } = await locate(ctx);
      for (const arg of rest.length ? rest : ["HEAD"]) {
        if (arg === "--show-toplevel") ctx.stdout.write(root + "\n");
        else if (arg === "--abbrev-ref") continue;
        else if (arg === "--is-inside-work-tree") ctx.stdout.write("true\n");
        else if (arg === "--git-dir") ctx.stdout.write(relativeTo(ctx, root, ".git") + "\n");
        else if (arg === "--short") continue;
        else if (arg === "HEAD" || arg === "@" || arg === snapshot.branch || arg === "origin/" + snapshot.branch) {
          if (rest.includes("--abbrev-ref")) ctx.stdout.write((snapshot.branch ?? "HEAD") + "\n");
          else if (!snapshot.commit) throw new CommandError("fatal: the commit of this snapshot is unknown", 128);
          else ctx.stdout.write((rest.includes("--short") ? snapshot.commit.slice(0, 7) : snapshot.commit) + "\n");
        } else throw new CommandError("fatal: ambiguous argument '" + arg + "': unknown revision (this clone is a source snapshot without history)", 128);
      }
      return 0;
    }
    case "branch": {
      const { snapshot } = await locate(ctx);
      if (rest.includes("--show-current")) ctx.stdout.write((snapshot.branch ?? "") + "\n");
      else {
        ctx.stdout.write("* " + (snapshot.branch ?? "(HEAD detached at " + (snapshot.commit?.slice(0, 7) ?? snapshot.ref) + ")") + "\n");
        if ((rest.includes("-a") || rest.includes("-r")) && snapshot.branch) ctx.stdout.write("  remotes/origin/" + snapshot.branch + "\n");
      }
      return 0;
    }
    case "remote": {
      const { snapshot } = await locate(ctx);
      if (rest[0] === "get-url") ctx.stdout.write(snapshot.url + "\n");
      else if (rest.includes("-v")) ctx.stdout.write("origin\t" + snapshot.url + " (fetch)\norigin\t" + snapshot.url + " (push)\n");
      else ctx.stdout.write("origin\n");
      return 0;
    }
    case "describe": {
      const { snapshot } = await locate(ctx);
      if (!snapshot.commit) throw new CommandError("fatal: No names found, cannot describe anything.", 128);
      ctx.stdout.write(snapshot.commit.slice(0, 7) + "\n");
      return 0;
    }
    case "ls-files": {
      const { root, snapshot } = await locate(ctx);
      const base = ctx.cwd === root ? "" : ctx.cwd.startsWith(root + "/") ? ctx.cwd.slice(root.length + 1) + "/" : null;
      for (const path of Object.keys(snapshot.files).sort()) if (base === null || path.startsWith(base)) ctx.stdout.write(relativeTo(ctx, root, path) + "\n");
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
      ctx.stdout.write("usage: git <command> [<args>]\n\nThis git downloads GitHub source snapshots (no history) and reports on them.\nSupported: " + SUPPORTED + ".\n  git clone [-b REF] [-q] https://github.com/OWNER/REPO [DIR]\n");
      return command === undefined ? 1 : 0;
    default:
      ctx.stderr.write("git: '" + command + "' is not supported by this shell's git, which downloads GitHub source snapshots without history.\nSupported: " + SUPPORTED + ".\nTo compare changes, keep a copy (cp -r) before editing and use diff -r; to publish, use the host's tools.\n");
      return 1;
  }
}

async function gh(ctx: CommandContext, github: GitHubOptions, args: string[]): Promise<number> {
  if (args[0] === "repo" && args[1] === "clone") {
    const rest = args.slice(2);
    const separator = rest.indexOf("--");
    const own = separator < 0 ? rest : rest.slice(0, separator);
    const flags = separator < 0 ? [] : rest.slice(separator + 1);
    const operands = own.filter(arg => !arg.startsWith("-"));
    if (!operands.length || operands.length > 2) throw new CommandError("usage: gh repo clone OWNER/REPO [DIRECTORY] [-- GITFLAGS...]", 1);
    const repository = repositoryOf(operands[0]);
    if (!repository) throw new CommandError("expected OWNER/REPO or a GitHub URL, got " + operands[0], 1);
    return clone(ctx, github, [...flags, "https://github.com/" + repository + ".git", ...operands.slice(1)]);
  }
  ctx.stderr.write("gh: only 'gh repo clone OWNER/REPO [DIRECTORY] [-- GITFLAGS...]' is available in this shell; it downloads a source snapshot without history.\n");
  return 1;
}

export function gitCommands(github: GitHubOptions = {}): Record<string, CommandHandler> {
  const plain = (run: (ctx: CommandContext) => Promise<number>): CommandHandler => async ctx => {
    try {
      return await run(ctx);
    } catch (error) {
      if (!(error instanceof CommandError) || !/^(fatal|error|usage): /.test(error.message)) throw error;
      ctx.stderr.write(error.message + "\n");
      return error.status;
    }
  };
  return {
    gh: plain(ctx => gh(ctx, github, ctx.args)),
    git: plain(ctx => git(ctx, github, ctx.args)),
  };
}

const ALLOWED = [/^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/(?:tar\.gz|legacy\.tar\.gz|zip|legacy\.zip)\//, /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:archive|releases\/download|raw)\//, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\//, /^https:\/\/(?:objects|release-assets)\.githubusercontent\.com\//, /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+(?:\/(?:tarball|zipball|commits|releases|contents)(?:\/[^?#]*)?)?(?:\?[^#]*)?$/];

export type GitHubToken = string | (() => string | null | undefined | Promise<string | null | undefined>);

export type GitHubFetchOptions = { token?: GitHubToken | undefined };

const API = "api.github.com";

const LIMITED = "x-nanocode-github";

export const GITHUB_RATE_LIMIT_HINT = "api.github.com rate limits unauthenticated requests per address (60 an hour), and this host shares its address with others. Read files from https://raw.githubusercontent.com/OWNER/REPO/REF/PATH, download archives from https://codeload.github.com/OWNER/REPO/tar.gz/REF, or run git clone, none of which use the API; the host can also set a GitHub token (its github.token option).";

async function tokenOf(token: GitHubToken | undefined): Promise<string | undefined> {
  const value = typeof token === "function" ? await token() : token;
  return value ? value : undefined;
}

async function rateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  if (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")) return true;
  const text = await response.clone().text().catch(() => "");
  return /rate limit/i.test(text);
}

async function head(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value, null, 2), { ...init, headers: { "content-type": "application/json; charset=utf-8", [LIMITED]: "fallback", ...init.headers } });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function defaultBranch(fetcher: typeof fetch, repository: string, signal: AbortSignal | null): Promise<{ branch: string | null; commit: string | null } | null> {
  const response = await fetcher("https://github.com/" + repository + ".git/info/refs?service=git-upload-pack", { headers: { "user-agent": "git/2.47.0" }, redirect: "follow", ...(signal ? { signal } : {}) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const text = await head(response, 16384);
  const branch = /symref=HEAD:refs\/heads\/([^\s\0]+)/.exec(text)?.[1] ?? null;
  const commit = /0000[0-9a-f]{4}([0-9a-f]{40}) HEAD\0/.exec(text)?.[1] ?? null;
  return branch || commit ? { branch, commit } : null;
}

async function commitOf(fetcher: typeof fetch, repository: string, ref: string, signal: AbortSignal | null): Promise<Record<string, unknown> | null> {
  const response = await fetcher("https://github.com/" + repository + "/commit/" + ref.split("/").map(encodeURIComponent).join("/") + ".patch", { headers: { "user-agent": "nanocode-ts" }, redirect: "follow", ...(signal ? { signal } : {}) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const text = await head(response, 65536);
  const sha = /^From ([0-9a-f]{40}) /.exec(text)?.[1];
  if (!sha) return null;
  const end = text.indexOf("\n\n");
  const headers = (end < 0 ? text : text.slice(0, end)).replace(/\n[ \t]+/g, " ");
  const field = (name: string) => new RegExp("^" + name + ": (.*)$", "m").exec(headers)?.[1] ?? null;
  const from = field("From");
  const person = from ? /^(.*?)\s*<([^>]*)>$/.exec(from) : null;
  const date = field("Date");
  const subject = (field("Subject") ?? "").replace(/^\[PATCH[^\]]*\]\s*/, "");
  const rest = end < 0 ? "" : text.slice(end + 2);
  const cut = rest.search(/^---$/m);
  const body = (cut < 0 ? "" : rest.slice(0, cut)).trim();
  const author = { name: person?.[1]?.replace(/^"|"$/g, "") ?? from, email: person?.[2] ?? null, date: date ? new Date(date).toISOString() : null };
  return { sha, html_url: "https://github.com/" + repository + "/commit/" + sha, commit: { author, committer: author, message: body ? subject + "\n\n" + body : subject } };
}

async function fallback(fetcher: typeof fetch, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return null;
  const repository = match[1] + "/" + match[2];
  const rest = match[3] ?? "";
  const signal = request.signal;
  const note = "api.github.com rate limited this request; this answer comes from " ;
  const archive = /^\/(tarball|zipball)(?:\/(.+))?$/.exec(rest);
  if (archive) {
    const response = await fetcher("https://codeload.github.com/" + repository + "/" + (archive[1] === "tarball" ? "tar.gz" : "zip") + "/" + (archive[2] ?? "HEAD"), { method: request.method, headers: { "user-agent": "nanocode-ts" }, redirect: "follow", signal });
    return response.ok ? response : null;
  }
  if (rest === "/releases/latest") {
    const response = await fetcher("https://github.com/" + repository + "/releases/latest", { method: "HEAD", headers: { "user-agent": "nanocode-ts" }, redirect: "manual", signal });
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location") ?? "";
    const tag = /\/releases\/tag\/([^?#]+)$/.exec(location)?.[1];
    if (!tag) return null;
    const name = decodeURIComponent(tag);
    return json({ tag_name: name, name, html_url: new URL(location, "https://github.com/").href, tarball_url: "https://codeload.github.com/" + repository + "/tar.gz/refs/tags/" + tag, zipball_url: "https://codeload.github.com/" + repository + "/zip/refs/tags/" + tag, assets_download_url: "https://github.com/" + repository + "/releases/download/" + tag + "/ASSET_NAME", nanocode_note: note + "github.com's latest-release redirect, so only the tag is known and assets are not listed" });
  }
  const contents = /^\/contents\/(.+)$/.exec(rest);
  if (contents && request.method === "GET") {
    const path = contents[1]!.replace(/\/+$/, "");
    const ref = url.searchParams.get("ref") ?? "HEAD";
    const download = "https://raw.githubusercontent.com/" + repository + "/" + ref.split("/").map(encodeURIComponent).join("/") + "/" + path;
    const response = await fetcher(download, { headers: { "user-agent": "nanocode-ts" }, redirect: "follow", signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (/raw/.test(request.headers.get("accept") ?? "")) return new Response(response.body, { status: 200, headers: { "content-type": response.headers.get("content-type") ?? "text/plain; charset=utf-8", [LIMITED]: "fallback" } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const file = decodeURIComponent(path);
    return json({ type: "file", encoding: "base64", size: bytes.length, name: file.split("/").pop(), path: file, content: base64(bytes), download_url: download, html_url: "https://github.com/" + repository + "/blob/" + ref + "/" + path, nanocode_note: note + "raw.githubusercontent.com, so sha is not known" });
  }
  const commit = /^\/commits\/([^?#]+)$/.exec(rest);
  if (commit) {
    const data = await commitOf(fetcher, repository, decodeURIComponent(commit[1]!), signal);
    return data ? json({ ...data, nanocode_note: note + "the commit's .patch on github.com, so stats and files are not listed" }) : null;
  }
  if (rest === "" || rest === "/") {
    const refs = await defaultBranch(fetcher, repository, signal);
    return refs?.branch ? json({ name: match[2], full_name: repository, default_branch: refs.branch, html_url: "https://github.com/" + repository, clone_url: "https://github.com/" + repository + ".git", private: false, nanocode_note: note + "git's ref advertisement, so only the name and default branch are known" }) : null;
  }
  return null;
}

async function limited(response: Response): Promise<Response> {
  const text = await response.text().catch(() => "");
  let message = "API rate limit exceeded";
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message.replace(/\.$/, "");
  } catch {}
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", [LIMITED]: "limited" });
  for (const [name, value] of response.headers) if (/^(x-ratelimit-|retry-after$)/.test(name)) headers.set(name, value);
  return new Response(JSON.stringify({ message: message + ". " + GITHUB_RATE_LIMIT_HINT, documentation_url: "https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api" }), { status: response.status, statusText: response.statusText, headers });
}

export function withGitHub(fetcher: typeof fetch, options: GitHubFetchOptions = {}): typeof fetch {
  const layer: typeof fetch = async (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).hostname !== API) return fetcher(input, init);
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    const token = request.method === "GET" || request.method === "HEAD" ? await tokenOf(options.token) : undefined;
    const authorized = token !== undefined && !headers.has("authorization");
    if (authorized) headers.set("authorization", "Bearer " + token);
    if (!headers.has("user-agent")) headers.set("user-agent", "nanocode-ts");
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    const mode = request.redirect;
    let response = await fetcher(request.url, { method: request.method, headers, body, redirect: authorized && mode === "follow" ? "manual" : mode, signal: request.signal });
    const location = response.headers.get("location");
    if (authorized && mode === "follow" && response.status >= 300 && response.status <= 399 && location !== null) {
      await response.body?.cancel().catch(() => undefined);
      const next = new URL(location, request.url);
      if (next.hostname !== API) headers.delete("authorization");
      response = await fetcher(next.href, { method: response.status === 303 ? "GET" : request.method, headers, body: response.status === 303 ? null : body, redirect: "follow", signal: request.signal });
    }
    if (response.headers.has(LIMITED) || !(await rateLimited(response))) return response;
    const alternative = await fallback(fetcher, request).catch(error => {
      if (request.signal.aborted) throw error;
      return null;
    });
    if (alternative) {
      await response.body?.cancel().catch(() => undefined);
      return alternative;
    }
    return limited(response);
  };
  return guarded(fetcher) ? mark(layer) : layer;
}

export function githubArchives(fetcher: typeof fetch = globalThis.fetch, options: GitHubFetchOptions = {}): typeof fetch {
  const network = withGitHub(fetcher, options);
  return mark(async (input, init) => {
    const request = new Request(input, init);
    if ((request.method !== "GET" && request.method !== "HEAD") || !ALLOWED.some(pattern => pattern.test(request.url))) throw new TypeError(request.method + " " + request.url + " refused: this host reaches only public GitHub repositories (raw.githubusercontent.com files, codeload.github.com archives, github.com/OWNER/REPO/archive/, /releases/download/ and /raw/ files, and GET https://api.github.com/repos/OWNER/REPO with its /contents, /commits, /releases, /tarball and /zipball), so no other URL works from cells, curl or wget");
    if (typeof (globalThis as { document?: unknown }).document !== "undefined") return network(request);
    if (!request.headers.has("user-agent")) request.headers.set("user-agent", "nanocode-ts");
    const mode = request.redirect;
    const headers = new Headers(request.headers);
    let url = request.url;
    for (let hop = 0; ; hop++) {
      const response = await network(url, { method: request.method, headers, redirect: "manual", signal: request.signal });
      const location = response.headers.get("location");
      if (mode === "manual" || response.status < 300 || response.status > 399 || location === null) return response;
      await response.body?.cancel().catch(() => undefined);
      const next = new URL(location, url).href;
      if (mode === "error" || hop >= 10 || !ALLOWED.some(pattern => pattern.test(next))) throw new TypeError(request.method + " " + url + " redirected to " + next + ", which this host does not reach (only public GitHub repositories)");
      if (new URL(next).origin !== new URL(url).origin) for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);
      url = next;
    }
  });
}

