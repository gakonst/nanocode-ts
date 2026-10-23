import type { SqlHost, SqlValue, Statement } from "../contracts.ts";
import { baseOf, FsError, normalize, parentOf, type FileStat, type FileSystem } from "./fs.ts";

const TABLE = "nanocode_files";

const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TABLE} (scope TEXT NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, kind TEXT NOT NULL, data BLOB, mtime INTEGER NOT NULL, mode INTEGER NOT NULL, PRIMARY KEY (scope, path))`;

const INDEX = `CREATE INDEX IF NOT EXISTS ${TABLE}_parent ON ${TABLE} (scope, parent)`;

type Row = { kind: "file" | "directory"; data: Uint8Array; mtime: number; mode: number };

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
    return { kind: row[0] === "directory" ? "directory" : "file", data: bytes(row[1] ?? null), mtime: Number(row[2]), mode: Number(row[3]) };
  }

  async #directory(path: string): Promise<void> {
    const row = await this.#row(path);
    if (!row) throw new FsError("ENOENT", path);
    if (row.kind !== "directory") throw new FsError("ENOTDIR", path);
  }

  #insert(path: string, kind: "file" | "directory", data: Uint8Array | null, mode: number, mtime = Date.now()): Statement {
    return [`INSERT OR REPLACE INTO ${TABLE} (scope, path, parent, kind, data, mtime, mode) VALUES (?, ?, ?, ?, ?, ?, ?)`, this.scope, path, parentOf(path), kind, data ? blob(data) : null, mtime, mode];
  }

  async stat(path: string): Promise<FileStat | null> {
    const row = await this.#row(normalize(path));
    if (!row) return null;
    return { kind: row.kind, size: row.kind === "file" ? row.data.length : 4096, mtime: row.mtime, mode: row.mode };
  }

  async read(path: string): Promise<Uint8Array> {
    const row = await this.#row(normalize(path));
    if (!row) throw new FsError("ENOENT", path);
    if (row.kind !== "file") throw new FsError("EISDIR", path);
    return row.data;
  }

  async write(path: string, data: Uint8Array, append = false): Promise<void> {
    const target = normalize(path);
    if (target === "/") throw new FsError("EISDIR", path);
    await this.#directory(parentOf(target));
    const existing = await this.#row(target);
    if (existing?.kind === "directory") throw new FsError("EISDIR", path);
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
    const target = normalize(path);
    await this.#directory(target);
    const [rows] = await this.#run("list", [[`SELECT path FROM ${TABLE} WHERE scope = ? AND parent = ? ORDER BY path`, this.scope, target]]);
    return (rows ?? []).map(row => baseOf(String(row[0]))).filter(Boolean).sort();
  }

  async mkdir(path: string): Promise<void> {
    const target = normalize(path);
    await this.#directory(parentOf(target));
    if (await this.#row(target)) throw new FsError("EEXIST", path);
    await this.#run("mkdir", [this.#insert(target, "directory", null, 0o755)]);
  }

  async remove(path: string): Promise<void> {
    const target = normalize(path);
    if (target === "/") throw new FsError("EINVAL", path);
    const row = await this.#row(target);
    if (!row) throw new FsError("ENOENT", path);
    if (row.kind === "directory") {
      const [children] = await this.#run("children", [[`SELECT 1 FROM ${TABLE} WHERE scope = ? AND parent = ? LIMIT 1`, this.scope, target]]);
      if (children?.length) throw new FsError("ENOTEMPTY", path);
    }
    await this.#run("remove", [[`DELETE FROM ${TABLE} WHERE scope = ? AND path = ?`, this.scope, target]]);
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalize(from);
    const target = normalize(to);
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
      moves.push(this.#insert(target + path.slice(source.length), row[1] === "directory" ? "directory" : "file", row[1] === "directory" ? null : bytes(row[2] ?? null), Number(row[4]), Number(row[3])));
    }
    await this.#run("rename", moves);
  }
}
