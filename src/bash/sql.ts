import type { SqlHost, SqlValue, Statement } from "../contracts.ts";
import { baseOf, decode, encode, FsError, normalize, parentOf, resolvePath, type FileStat, type FileSystem, type LinkStat } from "./fs.ts";

const TABLE = "nanocode_files";

const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TABLE} (scope TEXT NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, kind TEXT NOT NULL, data BLOB, mtime INTEGER NOT NULL, mode INTEGER NOT NULL, PRIMARY KEY (scope, path))`;

const INDEX = `CREATE INDEX IF NOT EXISTS ${TABLE}_parent ON ${TABLE} (scope, parent)`;

type Kind = "file" | "directory" | "link";

type Row = { kind: Kind; data: Uint8Array; mtime: number; mode: number };

function kindOf(value: SqlValue): Kind {
  return value === "directory" ? "directory" : value === "link" ? "link" : "file";
}

function bytes(value: SqlValue): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array((value as ArrayBufferView).buffer, (value as ArrayBufferView).byteOffset, (value as ArrayBufferView).byteLength);
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array();
}

function blob(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer as ArrayBuffer;
}

export class SqlFileSystem implements FileSystem {
  readonly sql: SqlHost;
  readonly scope: string;
  readonly maxFileBytes: number;
  #ready: Promise<void> | undefined;
  #links: Promise<boolean> | undefined;

  constructor(sql: SqlHost, scope = "", maxFileBytes = Math.min(sql.value_limit ?? 8 * 1024 * 1024, 64 * 1024 * 1024)) {
    this.sql = sql;
    this.scope = scope;
    this.maxFileBytes = maxFileBytes;
  }

  async #run(operation: string, statements: Statement[]): Promise<SqlValue[][][]> {
    this.#ready ??= Promise.resolve(this.sql.transaction("store", "files.schema", [[SCHEMA], [INDEX]])).then(() => undefined);
    await this.#ready;
    return await this.sql.transaction("store", `files.${operation}`, statements);
  }

  async #row(path: string): Promise<Row | undefined> {
    if (path === "/") return { kind: "directory", data: new Uint8Array(), mtime: 0, mode: 0o755 };
    const [rows] = await this.#run("get", [[`SELECT kind, data, mtime, mode FROM ${TABLE} WHERE scope = ? AND path = ?`, this.scope, path]]);
    const row = rows?.[0];
    if (!row) return undefined;
    return { kind: kindOf(row[0] ?? null), data: bytes(row[1] ?? null), mtime: Number(row[2]), mode: Number(row[3]) };
  }

  async #real(path: string, follow = true): Promise<string> {
    const normal = normalize(path);
    this.#links ??= this.#run("links", [[`SELECT 1 FROM ${TABLE} WHERE scope = ? AND kind = 'link' LIMIT 1`, this.scope]]).then(([rows]) => Boolean(rows?.length));
    if (!(await this.#links)) return normal;
    let parts = normal.split("/").filter(Boolean);
    for (let hops = 0; ; hops++) {
      const prefixes: string[] = [];
      for (let i = 1; i <= parts.length - (follow ? 0 : 1); i++) prefixes.push("/" + parts.slice(0, i).join("/"));
      if (!prefixes.length) break;
      const [rows] = await this.#run("resolve", [[`SELECT path, data FROM ${TABLE} WHERE scope = ? AND kind = 'link' AND path IN (${prefixes.map(() => "?").join(", ")})`, this.scope, ...prefixes]]);
      if (!rows?.length) break;
      if (hops >= 40) throw new FsError("ELOOP", path);
      const links = new Map(rows.map(row => [String(row[0]), decode(bytes(row[1] ?? null))]));
      const index = prefixes.findIndex(prefix => links.has(prefix));
      const target = resolvePath("/" + parts.slice(0, index).join("/"), links.get(prefixes[index]!)!);
      parts = [...target.split("/").filter(Boolean), ...parts.slice(index + 1)];
    }
    return "/" + parts.join("/");
  }

  async #resolved(path: string, follow = true): Promise<string | null> {
    try {
      return await this.#real(path, follow);
    } catch (error) {
      if (error instanceof FsError && error.code === "ELOOP") return null;
      throw error;
    }
  }

  async #directory(path: string): Promise<void> {
    const row = await this.#row(await this.#real(path));
    if (!row) throw new FsError("ENOENT", path);
    if (row.kind !== "directory") throw new FsError("ENOTDIR", path);
  }

  #insert(path: string, kind: Kind, data: Uint8Array | null, mode: number, mtime = Date.now()): Statement {
    return [`INSERT OR REPLACE INTO ${TABLE} (scope, path, parent, kind, data, mtime, mode) VALUES (?, ?, ?, ?, ?, ?, ?)`, this.scope, path, parentOf(path), kind, data ? blob(data) : null, mtime, mode];
  }

  async stat(path: string): Promise<FileStat | null> {
    const target = await this.#resolved(path);
    const row = target === null ? undefined : await this.#row(target);
    if (!row || row.kind === "link") return null;
    return { kind: row.kind, size: row.kind === "file" ? row.data.length : 4096, mtime: row.mtime, mode: row.mode };
  }

  async read(path: string): Promise<Uint8Array> {
    const row = await this.#row(await this.#real(path));
    if (!row || row.kind === "link") throw new FsError("ENOENT", path);
    if (row.kind !== "file") throw new FsError("EISDIR", path);
    return row.data;
  }

  async write(path: string, data: Uint8Array, append = false): Promise<void> {
    const target = await this.#real(path);
    if (target === "/") throw new FsError("EISDIR", path);
    await this.#directory(parentOf(target));
    const existing = await this.#row(target);
    if (existing?.kind === "directory") throw new FsError("EISDIR", path);
    if (existing?.kind === "link") throw new FsError("ENOENT", path);
    let content = data;
    if (append && existing) {
      content = new Uint8Array(existing.data.length + data.length);
      content.set(existing.data);
      content.set(data, existing.data.length);
    }
    if (content.length > this.maxFileBytes) throw new FsError("EFBIG", path);
    await this.#run("write", [this.#insert(target, "file", content, existing?.mode ?? 0o644)]);
  }

  async list(path: string): Promise<string[]> {
    const target = await this.#real(path);
    await this.#directory(target);
    const [rows] = await this.#run("list", [[`SELECT path FROM ${TABLE} WHERE scope = ? AND parent = ? ORDER BY path`, this.scope, target]]);
    return (rows ?? []).map(row => baseOf(String(row[0]))).filter(Boolean).sort();
  }

  async mkdir(path: string): Promise<void> {
    const target = await this.#real(path, false);
    await this.#directory(parentOf(target));
    if (await this.#row(target)) throw new FsError("EEXIST", path);
    await this.#run("mkdir", [this.#insert(target, "directory", null, 0o755)]);
  }

  async remove(path: string): Promise<void> {
    const target = await this.#real(path, false);
    if (target === "/") throw new FsError("EINVAL", path);
    const row = await this.#row(target);
    if (!row) throw new FsError("ENOENT", path);
    if (row.kind === "directory") {
      const [children] = await this.#run("children", [[`SELECT 1 FROM ${TABLE} WHERE scope = ? AND parent = ? LIMIT 1`, this.scope, target]]);
      if (children?.length) throw new FsError("ENOTEMPTY", path);
    }
    await this.#run("remove", [[`DELETE FROM ${TABLE} WHERE scope = ? AND path = ?`, this.scope, target]]);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const target = await this.#real(path);
    const row = await this.#row(target);
    if (!row || row.kind === "link") throw new FsError("ENOENT", path);
    await this.#run("chmod", [[`UPDATE ${TABLE} SET mode = ? WHERE scope = ? AND path = ?`, mode & 0o7777, this.scope, target]]);
  }

  async utimes(path: string, mtime: number): Promise<void> {
    const target = await this.#real(path);
    const row = await this.#row(target);
    if (!row || row.kind === "link") throw new FsError("ENOENT", path);
    await this.#run("utimes", [[`UPDATE ${TABLE} SET mtime = ? WHERE scope = ? AND path = ?`, Math.floor(mtime), this.scope, target]]);
  }

  async symlink(target: string, path: string): Promise<void> {
    const link = await this.#real(path, false);
    if (link === "/") throw new FsError("EEXIST", path);
    await this.#directory(parentOf(link));
    if (await this.#row(link)) throw new FsError("EEXIST", path);
    await this.#run("symlink", [this.#insert(link, "link", encode(target), 0o777)]);
    this.#links = Promise.resolve(true);
  }

  async readlink(path: string): Promise<string | null> {
    const link = await this.#resolved(path, false);
    const row = link === null ? undefined : await this.#row(link);
    return row?.kind === "link" ? decode(row.data) : null;
  }

  async lstat(path: string): Promise<LinkStat | null> {
    const link = await this.#resolved(path, false);
    const row = link === null ? undefined : await this.#row(link);
    if (!row) return null;
    if (row.kind === "link") return { kind: "symlink", size: row.data.length, mtime: row.mtime, mode: 0o777, target: decode(row.data) };
    return { kind: row.kind, size: row.kind === "file" ? row.data.length : 4096, mtime: row.mtime, mode: row.mode };
  }

  async rename(from: string, to: string): Promise<void> {
    const source = await this.#real(from, false);
    const target = await this.#real(to, false);
    if (target === source) return;
    if (target.startsWith(source + "/") || source === "/") throw new FsError("EINVAL", to);
    const node = await this.#row(source);
    if (!node) throw new FsError("ENOENT", from);
    await this.#directory(parentOf(target));
    const existing = await this.#row(target);
    if (existing?.kind === "directory") throw new FsError("EISDIR", to);
    const [rows] = await this.#run("subtree", [[`SELECT path, kind, data, mtime, mode FROM ${TABLE} WHERE scope = ? AND (path = ? OR substr(path, 1, ?) = ?)`, this.scope, source, source.length + 1, source + "/"]]);
    const moves: Statement[] = [[`DELETE FROM ${TABLE} WHERE scope = ? AND path = ?`, this.scope, target]];
    for (const row of rows ?? []) {
      const path = String(row[0]);
      moves.push([`DELETE FROM ${TABLE} WHERE scope = ? AND path = ?`, this.scope, path]);
      const kind = kindOf(row[1] ?? null);
      moves.push(this.#insert(target + path.slice(source.length), kind, kind === "directory" ? null : bytes(row[2] ?? null), Number(row[4]), Number(row[3])));
    }
    await this.#run("rename", moves);
  }
}
