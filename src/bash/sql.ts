import type { SqlHost, SqlValue, Statement } from "../contracts.ts";
import { baseOf, decode, encode, FsError, normalize, parentOf, resolvePath, writeEach, type FileStat, type FileSystem, type LinkStat, type NewFile } from "./fs.ts";

const TABLE = "nanocode_files";

const CHUNKS = "nanocode_file_chunks";

const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TABLE} (scope TEXT NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, kind TEXT NOT NULL, data BLOB, mtime INTEGER NOT NULL, mode INTEGER NOT NULL, PRIMARY KEY (scope, path))`;

const INDEX = `CREATE INDEX IF NOT EXISTS ${TABLE}_parent ON ${TABLE} (scope, parent)`;

const CHUNK_SCHEMA = `CREATE TABLE IF NOT EXISTS ${CHUNKS} (scope TEXT NOT NULL, path TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (scope, path, seq))`;

const CHUNK_BYTES = 1 << 20;

const MAX_FILE_BYTES = 32 * 1024 * 1024;

const STAGED_BYTES = 4 * 1024 * 1024;

const STAGING = "//staging";

const BREATH_OPERATIONS = 64;

const LISTED_MS = 1000;

const READS = new Set(["stat", "get", "links", "resolve", "list", "children", "tail"]);

const BREATH_BYTES = 4 * 1024 * 1024;

let operations = 0;

let moved = 0;

function weight(value: SqlValue | undefined): number {
  return value instanceof ArrayBuffer ? value.byteLength : typeof value === "string" ? value.length : 0;
}

async function breathe(statements: Statement[], results: SqlValue[][][]): Promise<void> {
  operations++;
  for (const statement of statements) for (let index = 1; index < statement.length; index++) moved += weight(statement[index]);
  for (const rows of results) for (const row of rows ?? []) for (const value of row) moved += weight(value);
  if (operations < BREATH_OPERATIONS && moved < BREATH_BYTES) return;
  operations = 0;
  moved = 0;
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

type Kind = "file" | "directory" | "link";

type Meta = { kind: Kind; size: number; chunked: boolean; mtime: number; mode: number; inline?: Uint8Array };

type Row = Meta & { data: Uint8Array };

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

function joined(parts: Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export class SqlFileSystem implements FileSystem {
  readonly sql: SqlHost;
  readonly scope: string;
  readonly maxFileBytes: number;
  readonly chunkBytes: number;
  #ready: Promise<void> | undefined;
  #links: Promise<boolean> | undefined;
  #listed = new Map<string, Meta>();
  #listedAt = 0;
  #generation = 0;

  constructor(sql: SqlHost, scope = "", maxFileBytes = MAX_FILE_BYTES) {
    this.sql = sql;
    this.scope = scope;
    this.maxFileBytes = maxFileBytes;
    this.chunkBytes = Math.min(CHUNK_BYTES, Math.max(4096, Math.floor((sql.value_limit ?? CHUNK_BYTES) / 2)));
  }

  async #run(operation: string, statements: Statement[]): Promise<SqlValue[][][]> {
    this.#ready ??= Promise.resolve(this.sql.transaction("store", "files.schema", [[SCHEMA], [INDEX], [CHUNK_SCHEMA]])).then(() => undefined);
    await this.#ready;
    if (!READS.has(operation)) {
      this.#generation++;
      this.#listed.clear();
    }
    const results = await this.sql.transaction("store", `files.${operation}`, statements);
    await breathe(statements, results);
    return results;
  }

  async #meta(path: string, inline = false): Promise<Meta | undefined> {
    if (path === "/") return { kind: "directory", size: 4096, chunked: false, mtime: 0, mode: 0o755 };
    if (!inline && this.#listed.size) {
      if (Date.now() - this.#listedAt > LISTED_MS) this.#listed.clear();
      const listed = this.#listed.get(path);
      if (listed) return listed;
    }
    const [rows] = await this.#run("stat", [[`SELECT kind, CASE WHEN data IS NULL AND kind = 'file' THEN (SELECT COALESCE(SUM(length(c.data)), 0) FROM ${CHUNKS} c WHERE c.scope = f.scope AND c.path = f.path) ELSE length(data) END, data IS NULL, mtime, mode, CASE WHEN ? THEN data END FROM ${TABLE} f WHERE scope = ? AND path = ?`, inline ? 1 : 0, this.scope, path]]);
    const row = rows?.[0];
    if (!row) return undefined;
    const kind = kindOf(row[0] ?? null);
    const chunked = kind === "file" && Number(row[2]) === 1;
    return { kind, size: Number(row[1] ?? 0), chunked, mtime: Number(row[3]), mode: Number(row[4]), ...(inline && !chunked ? { inline: bytes(row[5] ?? null) } : {}) };
  }

  async #row(path: string): Promise<Row | undefined> {
    if (path === "/") return { kind: "directory", size: 4096, chunked: false, data: new Uint8Array(), mtime: 0, mode: 0o755 };
    const [rows, chunks] = await this.#run("get", [
      [`SELECT kind, data, mtime, mode FROM ${TABLE} WHERE scope = ? AND path = ?`, this.scope, path],
      [`SELECT data FROM ${CHUNKS} WHERE scope = ? AND path = ? ORDER BY seq`, this.scope, path],
    ]);
    const row = rows?.[0];
    if (!row) return undefined;
    const kind = kindOf(row[0] ?? null);
    const chunked = kind === "file" && row[1] === null && Boolean(chunks?.length);
    const parts = chunked ? chunks!.map(chunk => bytes(chunk[0] ?? null)) : [bytes(row[1] ?? null)];
    const size = parts.reduce((total, part) => total + part.length, 0);
    return { kind, size, chunked, data: joined(parts, size), mtime: Number(row[2]), mode: Number(row[3]) };
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
    const row = await this.#meta(await this.#real(path));
    if (!row) throw new FsError("ENOENT", path);
    if (row.kind !== "directory") throw new FsError("ENOTDIR", path);
  }

  #insert(path: string, kind: Kind, data: Uint8Array | null, mode: number, mtime = Date.now()): Statement {
    return [`INSERT OR REPLACE INTO ${TABLE} (scope, path, parent, kind, data, mtime, mode) VALUES (?, ?, ?, ?, ?, ?, ?)`, this.scope, path, parentOf(path), kind, data ? blob(data) : null, mtime, mode];
  }

  #drop(path: string): Statement {
    return [`DELETE FROM ${CHUNKS} WHERE scope = ? AND path = ?`, this.scope, path];
  }

  #chunks(path: string, data: Uint8Array, first: number): Statement[] {
    const statements: Statement[] = [];
    for (let offset = 0, seq = first; offset < data.length; offset += this.chunkBytes, seq++) statements.push([`INSERT OR REPLACE INTO ${CHUNKS} (scope, path, seq, data) VALUES (?, ?, ?, ?)`, this.scope, path, seq, blob(data.subarray(offset, offset + this.chunkBytes))]);
    return statements;
  }

  async #staged(target: string, data: Uint8Array, mode: number): Promise<void> {
    const staging = STAGING + target;
    await this.#run("write.stage", [this.#drop(staging)]);
    try {
      const step = Math.max(1, Math.floor(STAGED_BYTES / this.chunkBytes)) * this.chunkBytes;
      for (let offset = 0; offset < data.length; offset += step) await this.#run("write.chunk", this.#chunks(staging, data.subarray(offset, offset + step), offset / this.chunkBytes));
      await this.#run("write", [this.#drop(target), this.#insert(target, "file", null, mode), [`UPDATE ${CHUNKS} SET path = ? WHERE scope = ? AND path = ?`, target, this.scope, staging]]);
    } catch (error) {
      await this.#run("write.unstage", [this.#drop(staging)]).catch(() => {});
      throw error;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    const target = await this.#resolved(path);
    const row = target === null ? undefined : await this.#meta(target);
    if (!row || row.kind === "link") return null;
    return { kind: row.kind, size: row.kind === "file" ? row.size : 4096, mtime: row.mtime, mode: row.mode };
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
    const existing = await this.#meta(target, append);
    if (existing?.kind === "directory") throw new FsError("EISDIR", path);
    if (existing?.kind === "link") throw new FsError("ENOENT", path);
    const mode = existing?.mode ?? 0o644;
    if (!append || !existing) {
      if (data.length > this.maxFileBytes) throw new FsError("EFBIG", path);
      if (data.length <= this.chunkBytes) await this.#run("write", [this.#drop(target), this.#insert(target, "file", data, mode)]);
      else if (data.length <= STAGED_BYTES) await this.#run("write", [this.#drop(target), this.#insert(target, "file", null, mode), ...this.#chunks(target, data, 0)]);
      else await this.#staged(target, data, mode);
      return;
    }
    if (!data.length) return;
    if (existing.size + data.length > this.maxFileBytes) throw new FsError("EFBIG", path);
    if (!existing.chunked) {
      const current = existing.inline ?? new Uint8Array();
      const content = joined([current, data], current.length + data.length);
      if (content.length <= this.chunkBytes) await this.#run("write", [this.#insert(target, "file", content, mode)]);
      else await this.#run("append", [this.#insert(target, "file", null, mode), ...this.#chunks(target, content, 0)]);
      return;
    }
    const [last] = await this.#run("tail", [[`SELECT seq, data FROM ${CHUNKS} WHERE scope = ? AND path = ? ORDER BY seq DESC LIMIT 1`, this.scope, target]]);
    const seq = last?.[0] ? Number(last[0][0]) : 0;
    const tail = last?.[0] ? bytes(last[0][1] ?? null) : new Uint8Array();
    const fill = tail.length < this.chunkBytes;
    await this.#run("append", [[`UPDATE ${TABLE} SET mtime = ? WHERE scope = ? AND path = ?`, Date.now(), this.scope, target], ...this.#chunks(target, fill ? joined([tail, data], tail.length + data.length) : data, fill ? seq : seq + 1)]);
  }

  async writeMany(dirs: string[], files: NewFile[]): Promise<string[]> {
    this.#links ??= this.#run("links", [[`SELECT 1 FROM ${TABLE} WHERE scope = ? AND kind = 'link' LIMIT 1`, this.scope]]).then(([rows]) => Boolean(rows?.length));
    if (await this.#links) return writeEach(this, dirs, files);
    const refused: string[] = [];
    let batch: Statement[] = dirs.filter(dir => dir !== "/").map(dir => [`INSERT OR IGNORE INTO ${TABLE} (scope, path, parent, kind, data, mtime, mode) VALUES (?, ?, ?, 'directory', NULL, ?, ?)`, this.scope, dir, parentOf(dir), Date.now(), 0o755]);
    let bytes = 0;
    const flush = async () => {
      if (batch.length) await this.#run("write.many", batch);
      batch = [];
      bytes = 0;
    };
    for (const file of files) {
      if (file.data.length > this.maxFileBytes) {
        refused.push(file.path);
        continue;
      }
      if (file.data.length > STAGED_BYTES) {
        await flush();
        await this.#staged(file.path, file.data, 0o644);
        await this.#run("utimes", [[`UPDATE ${TABLE} SET mtime = ? WHERE scope = ? AND path = ?`, file.mtime, this.scope, file.path]]);
        continue;
      }
      if (bytes + file.data.length > STAGED_BYTES) await flush();
      batch.push(this.#drop(file.path));
      if (file.data.length <= this.chunkBytes) batch.push(this.#insert(file.path, "file", file.data, 0o644, file.mtime));
      else batch.push(this.#insert(file.path, "file", null, 0o644, file.mtime), ...this.#chunks(file.path, file.data, 0));
      bytes += file.data.length;
    }
    await flush();
    return refused;
  }

  async list(path: string): Promise<string[]> {
    const target = await this.#real(path);
    await this.#directory(target);
    const generation = this.#generation;
    const [rows] = await this.#run("list", [[`SELECT path, kind, CASE WHEN data IS NULL AND kind = 'file' THEN (SELECT COALESCE(SUM(length(c.data)), 0) FROM ${CHUNKS} c WHERE c.scope = f.scope AND c.path = f.path) ELSE length(data) END, data IS NULL, mtime, mode FROM ${TABLE} f WHERE scope = ? AND parent = ?`, this.scope, target]]);
    if (Date.now() - this.#listedAt > LISTED_MS) this.#listed.clear();
    this.#listedAt = Date.now();
    if (generation === this.#generation) for (const row of rows ?? []) {
      const kind = kindOf(row[1] ?? null);
      this.#listed.set(String(row[0]), { kind, size: Number(row[2] ?? 0), chunked: kind === "file" && Number(row[3]) === 1, mtime: Number(row[4]), mode: Number(row[5]) });
    }
    return (rows ?? []).map(row => baseOf(String(row[0]))).filter(Boolean).sort();
  }

  async mkdir(path: string): Promise<void> {
    const target = await this.#real(path, false);
    await this.#directory(parentOf(target));
    if (await this.#meta(target)) throw new FsError("EEXIST", path);
    await this.#run("mkdir", [this.#insert(target, "directory", null, 0o755)]);
  }

  async remove(path: string): Promise<void> {
    const target = await this.#real(path, false);
    if (target === "/") throw new FsError("EINVAL", path);
    const row = await this.#meta(target);
    if (!row) throw new FsError("ENOENT", path);
    if (row.kind === "directory") {
      const [children] = await this.#run("children", [[`SELECT 1 FROM ${TABLE} WHERE scope = ? AND parent = ? LIMIT 1`, this.scope, target]]);
      if (children?.length) throw new FsError("ENOTEMPTY", path);
    }
    await this.#run("remove", [[`DELETE FROM ${TABLE} WHERE scope = ? AND path = ?`, this.scope, target], this.#drop(target)]);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const target = await this.#real(path);
    const row = await this.#meta(target);
    if (!row || row.kind === "link") throw new FsError("ENOENT", path);
    await this.#run("chmod", [[`UPDATE ${TABLE} SET mode = ? WHERE scope = ? AND path = ?`, mode & 0o7777, this.scope, target]]);
  }

  async utimes(path: string, mtime: number): Promise<void> {
    const target = await this.#real(path);
    const row = await this.#meta(target);
    if (!row || row.kind === "link") throw new FsError("ENOENT", path);
    await this.#run("utimes", [[`UPDATE ${TABLE} SET mtime = ? WHERE scope = ? AND path = ?`, Math.floor(mtime), this.scope, target]]);
  }

  async symlink(target: string, path: string): Promise<void> {
    const link = await this.#real(path, false);
    if (link === "/") throw new FsError("EEXIST", path);
    await this.#directory(parentOf(link));
    if (await this.#meta(link)) throw new FsError("EEXIST", path);
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
    const meta = link === null ? undefined : await this.#meta(link);
    if (!meta) return null;
    if (meta.kind !== "link") return { kind: meta.kind, size: meta.kind === "file" ? meta.size : 4096, mtime: meta.mtime, mode: meta.mode };
    const row = await this.#row(link!);
    if (!row) return null;
    return { kind: "symlink", size: row.data.length, mtime: row.mtime, mode: 0o777, target: decode(row.data) };
  }

  async rename(from: string, to: string): Promise<void> {
    const source = await this.#real(from, false);
    const target = await this.#real(to, false);
    if (target === source) return;
    if (target.startsWith(source + "/") || source === "/") throw new FsError("EINVAL", to);
    const node = await this.#meta(source);
    if (!node) throw new FsError("ENOENT", from);
    await this.#directory(parentOf(target));
    const existing = await this.#meta(target);
    if (existing?.kind === "directory") throw new FsError("EISDIR", to);
    const within = "(path = ? OR substr(path, 1, ?) = ?)";
    const subtree = [source, source.length + 1, source + "/"];
    const tail = source.length + 1;
    await this.#run("rename", [
      [`DELETE FROM ${TABLE} WHERE scope = ? AND path = ?`, this.scope, target],
      this.#drop(target),
      [`UPDATE ${TABLE} SET parent = CASE WHEN path = ? THEN ? ELSE ? || substr(parent, ?) END, path = ? || substr(path, ?) WHERE scope = ? AND ${within}`, source, parentOf(target), target, tail, target, tail, this.scope, ...subtree],
      [`UPDATE ${CHUNKS} SET path = ? || substr(path, ?) WHERE scope = ? AND ${within}`, target, tail, this.scope, ...subtree],
    ]);
  }
}
