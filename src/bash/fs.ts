export type FileKind = "file" | "directory";

export type FileStat = { kind: FileKind; size: number; mtime: number; mode: number };

export type LinkStat = { kind: FileKind | "symlink"; size: number; mtime: number; mode: number; target?: string };

export interface FileSystem {
  stat(path: string): Promise<FileStat | null>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, append?: boolean): Promise<void>;
  list(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
  utimes?(path: string, mtime: number): Promise<void>;
  symlink?(target: string, path: string): Promise<void>;
  readlink?(path: string): Promise<string | null>;
  lstat?(path: string): Promise<LinkStat | null>;
  search?(dir: string, literals: string[]): Promise<string[] | null>;
  excerpt?(path: string, literals: string[]): Promise<Uint8Array | null>;
  matches?(dir: string, literals: string[], ignoreCase: boolean): Promise<string[] | null>;
  writeMany?(dirs: string[], files: NewFile[]): Promise<string[]>;
}

export type NewFile = { path: string; data: Uint8Array; mtime: number };

export type FileInput = string | Uint8Array;

export function writeMany(fs: FileSystem, dirs: string[], files: NewFile[]): Promise<string[]> {
  return fs.writeMany ? fs.writeMany(dirs, files) : writeEach(fs, dirs, files);
}

export async function writeEach(fs: FileSystem, dirs: string[], files: NewFile[]): Promise<string[]> {
  for (const dir of dirs) if (!(await fs.stat(dir))) await fs.mkdir(dir);
  const refused: string[] = [];
  for (const file of files) {
    try {
      await fs.write(file.path, file.data);
    } catch (error) {
      if (!(error instanceof FsError) || error.code !== "EFBIG") throw error;
      refused.push(file.path);
      continue;
    }
    if (fs.utimes) await fs.utimes(file.path, file.mtime);
    else file.mtime = (await fs.stat(file.path))?.mtime ?? file.mtime;
  }
  return refused;
}

export function masked(fs: FileSystem, umask: number): FileSystem {
  const chmod = fs.chmod?.bind(fs);
  if (umask === 0o022 || !chmod) return fs;
  return {
    stat: path => fs.stat(path),
    read: path => fs.read(path),
    write: async (path, data, append) => {
      const existed = await fs.stat(path);
      await fs.write(path, data, append);
      if (!existed) await chmod(path, 0o666 & ~umask);
    },
    list: path => fs.list(path),
    mkdir: async path => {
      await fs.mkdir(path);
      await chmod(path, 0o777 & ~umask);
    },
    remove: path => fs.remove(path),
    rename: (from, to) => fs.rename(from, to),
    chmod,
    ...(fs.utimes ? { utimes: fs.utimes.bind(fs) } : {}),
    ...(fs.symlink ? { symlink: fs.symlink.bind(fs) } : {}),
    ...(fs.readlink ? { readlink: fs.readlink.bind(fs) } : {}),
    ...(fs.lstat ? { lstat: fs.lstat.bind(fs) } : {}),
    ...(fs.search ? { search: fs.search.bind(fs) } : {}),
    ...(fs.excerpt ? { excerpt: fs.excerpt.bind(fs) } : {}),
    ...(fs.matches ? { matches: fs.matches.bind(fs) } : {}),
  };
}

export class FsError extends Error {
  readonly code: string;
  constructor(code: string, path: string) {
    super(`${path}: ${FS_MESSAGES[code] ?? code}`);
    this.code = code;
  }
}

const FS_MESSAGES: Record<string, string> = {
  ENOENT: "No such file or directory",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  ENOTEMPTY: "Directory not empty",
  EFBIG: "File too large",
  EINVAL: "Invalid argument",
  ELOOP: "Too many levels of symbolic links",
  EROFS: "Read-only file system",
  EXDEV: "Invalid cross-device link",
  EBUSY: "Device or resource busy",
};

const encoder = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function byte(value: number): string {
  const b = value & 0xff;
  return String.fromCharCode(b < 0x80 ? b : 0xdc00 + b);
}

export function encode(text: string): Uint8Array {
  if (!LONE.test(text)) return encoder.encode(text);
  const out = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) {
      out[n++] = c;
      continue;
    }
    if (c >= 0xdc80 && c <= 0xdcff) {
      out[n++] = c - 0xdc00;
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
        out[n++] = 0xf0 | (c >> 18);
        out[n++] = 0x80 | ((c >> 12) & 0x3f);
        out[n++] = 0x80 | ((c >> 6) & 0x3f);
        out[n++] = 0x80 | (c & 0x3f);
        continue;
      }
      c = 0xfffd;
    } else if (c >= 0xdc00 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x800) {
      out[n++] = 0xc0 | (c >> 6);
      out[n++] = 0x80 | (c & 0x3f);
    } else {
      out[n++] = 0xe0 | (c >> 12);
      out[n++] = 0x80 | ((c >> 6) & 0x3f);
      out[n++] = 0x80 | (c & 0x3f);
    }
  }
  return out.slice(0, n);
}

export function decode(bytes: Uint8Array): string {
  try {
    return strict.decode(bytes);
  } catch {
    return escaped(bytes);
  }
}

function escaped(bytes: Uint8Array): string {
  const units = new Uint16Array(bytes.length);
  const length = bytes.length;
  const cont = (i: number) => i < length && (bytes[i] & 0xc0) === 0x80;
  let n = 0;
  let i = 0;
  while (i < length) {
    const b = bytes[i];
    if (b < 0x80) {
      units[n++] = b;
      i++;
      continue;
    }
    const b1 = bytes[i + 1] ?? 0;
    if (b >= 0xc2 && b <= 0xdf && cont(i + 1)) {
      units[n++] = ((b & 0x1f) << 6) | (b1 & 0x3f);
      i += 2;
      continue;
    }
    if (b >= 0xe0 && b <= 0xef && b1 >= (b === 0xe0 ? 0xa0 : 0x80) && b1 <= (b === 0xed ? 0x9f : 0xbf) && cont(i + 2)) {
      units[n++] = ((b & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      i += 3;
      continue;
    }
    if (b >= 0xf0 && b <= 0xf4 && b1 >= (b === 0xf0 ? 0x90 : 0x80) && b1 <= (b === 0xf4 ? 0x8f : 0xbf) && cont(i + 2) && cont(i + 3)) {
      const c = (((b & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)) - 0x10000;
      units[n++] = 0xd800 + (c >> 10);
      units[n++] = 0xdc00 + (c & 0x3ff);
      i += 4;
      continue;
    }
    units[n++] = 0xdc00 + b;
    i++;
  }
  let out = "";
  for (let start = 0; start < n; start += 0x8000) out += String.fromCharCode(...units.subarray(start, Math.min(n, start + 0x8000)));
  return out;
}

export function rejoin(text: string): string {
  return LONE.test(text) ? decode(encode(text)) : text;
}

export function display(text: string): string {
  return LONE.test(text) ? lossy.decode(encode(text)) : text;
}

export function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

export function resolvePath(cwd: string, path: string): string {
  return normalize(path.startsWith("/") ? path : cwd + "/" + path);
}

export function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

type Node = { kind: "file"; data: Uint8Array; buffer?: Uint8Array; mtime: number; mode: number } | { kind: "directory"; children: Map<string, Node>; mtime: number; mode: number } | { kind: "link"; target: string; mtime: number; mode: number };

export class MemoryFileSystem implements FileSystem {
  #root: Node = { kind: "directory", children: new Map(), mtime: Date.now(), mode: 0o755 };
  #links = 0;
  readonly maxFileBytes: number;

  constructor(files: Record<string, FileInput> = {}, maxFileBytes = 64 * 1024 * 1024) {
    this.maxFileBytes = maxFileBytes;
    for (const [path, content] of Object.entries(files)) this.#seed(normalize(path), typeof content === "string" ? encode(content) : content);
  }

  #seed(path: string, data: Uint8Array) {
    let node = this.#root;
    const parts = path.split("/").filter(Boolean);
    for (const part of parts.slice(0, -1)) {
      if (node.kind !== "directory") throw new FsError("ENOTDIR", path);
      let next = node.children.get(part);
      if (!next) node.children.set(part, next = { kind: "directory", children: new Map(), mtime: Date.now(), mode: 0o755 });
      node = next;
    }
    if (node.kind !== "directory") throw new FsError("ENOTDIR", path);
    node.children.set(parts[parts.length - 1], { kind: "file", data, mtime: Date.now(), mode: 0o644 });
  }

  #find(path: string): Node | undefined {
    let node: Node | undefined = this.#root;
    for (const part of normalize(path).split("/").filter(Boolean)) {
      if (!node || node.kind !== "directory") return undefined;
      node = node.children.get(part);
    }
    return node;
  }

  #real(path: string, follow = true): string {
    if (!this.#links) return normalize(path);
    let parts = normalize(path).split("/").filter(Boolean);
    let hops = 0;
    for (let i = 0; i < parts.length; i++) {
      if (!follow && i === parts.length - 1) break;
      const node = this.#find("/" + parts.slice(0, i + 1).join("/"));
      if (!node) break;
      if (node.kind !== "link") continue;
      if (++hops > 40) throw new FsError("ELOOP", path);
      const target = resolvePath("/" + parts.slice(0, i).join("/"), node.target);
      parts = [...target.split("/").filter(Boolean), ...parts.slice(i + 1)];
      i = -1;
    }
    return "/" + parts.join("/");
  }

  #directory(path: string): Map<string, Node> {
    const node = this.#find(path);
    if (!node) throw new FsError("ENOENT", path);
    if (node.kind !== "directory") throw new FsError("ENOTDIR", path);
    return node.children;
  }

  async stat(path: string): Promise<FileStat | null> {
    let real: string;
    try {
      real = this.#real(path);
    } catch (error) {
      if (error instanceof FsError && error.code === "ELOOP") return null;
      throw error;
    }
    const node = this.#find(real);
    if (!node || node.kind === "link") return null;
    return { kind: node.kind, size: node.kind === "file" ? node.data.length : 4096, mtime: node.mtime, mode: node.mode };
  }

  async read(path: string): Promise<Uint8Array> {
    const node = this.#find(this.#real(path));
    if (!node || node.kind === "link") throw new FsError("ENOENT", path);
    if (node.kind !== "file") throw new FsError("EISDIR", path);
    return node.data;
  }

  async write(path: string, data: Uint8Array, append = false): Promise<void> {
    const target = this.#real(path);
    const parent = this.#directory(parentOf(target));
    const name = baseOf(target);
    if (!name) throw new FsError("EISDIR", path);
    const existing = parent.get(name);
    if (existing?.kind === "directory") throw new FsError("EISDIR", path);
    if (existing?.kind === "link") throw new FsError("ENOENT", path);
    if (append && existing && data.length) {
      const length = existing.data.length + data.length;
      if (length > this.maxFileBytes) throw new FsError("EFBIG", path);
      let buffer = existing.buffer;
      if (!buffer || buffer.length < length || buffer.subarray(0, existing.data.length).byteOffset !== existing.data.byteOffset || buffer.buffer !== existing.data.buffer) {
        buffer = new Uint8Array(Math.min(this.maxFileBytes, Math.max(length, existing.data.length * 2, 4096)));
        buffer.set(existing.data);
      }
      buffer.set(data, existing.data.length);
      existing.buffer = buffer;
      existing.data = buffer.subarray(0, length);
      existing.mtime = Date.now();
      return;
    }
    const bytes = append && existing ? existing.data : data;
    if (bytes.length > this.maxFileBytes) throw new FsError("EFBIG", path);
    parent.set(name, { kind: "file", data: bytes, mtime: Date.now(), mode: existing?.mode ?? 0o644 });
  }

  async writeMany(dirs: string[], files: NewFile[]): Promise<string[]> {
    for (const dir of dirs) if (this.#find(this.#real(dir))?.kind !== "directory") await this.mkdir(dir);
    const refused: string[] = [];
    for (const file of files) {
      if (file.data.length > this.maxFileBytes) {
        refused.push(file.path);
        continue;
      }
      await this.write(file.path, file.data);
      const node = this.#find(this.#real(file.path));
      if (node?.kind === "file") node.mtime = file.mtime;
    }
    return refused;
  }

  async list(path: string): Promise<string[]> {
    return [...this.#directory(this.#real(path)).keys()].sort();
  }

  async mkdir(path: string): Promise<void> {
    const target = this.#real(path, false);
    const parent = this.#directory(parentOf(target));
    if (parent.has(baseOf(target))) throw new FsError("EEXIST", path);
    parent.set(baseOf(target), { kind: "directory", children: new Map(), mtime: Date.now(), mode: 0o755 });
  }

  async remove(path: string): Promise<void> {
    const target = this.#real(path, false);
    if (target === "/") throw new FsError("EINVAL", path);
    const parent = this.#directory(parentOf(target));
    const node = parent.get(baseOf(target));
    if (!node) throw new FsError("ENOENT", path);
    if (node.kind === "directory" && node.children.size) throw new FsError("ENOTEMPTY", path);
    parent.delete(baseOf(target));
  }

  async chmod(path: string, mode: number): Promise<void> {
    const node = this.#find(this.#real(path));
    if (!node || node.kind === "link") throw new FsError("ENOENT", path);
    node.mode = mode & 0o7777;
  }

  async utimes(path: string, mtime: number): Promise<void> {
    const node = this.#find(this.#real(path));
    if (!node || node.kind === "link") throw new FsError("ENOENT", path);
    node.mtime = mtime;
  }

  async symlink(target: string, path: string): Promise<void> {
    const link = this.#real(path, false);
    const parent = this.#directory(parentOf(link));
    if (link === "/" || parent.has(baseOf(link))) throw new FsError("EEXIST", path);
    parent.set(baseOf(link), { kind: "link", target, mtime: Date.now(), mode: 0o777 });
    this.#links++;
  }

  async readlink(path: string): Promise<string | null> {
    const node = this.#find(this.#real(path, false));
    return node?.kind === "link" ? node.target : null;
  }

  async lstat(path: string): Promise<LinkStat | null> {
    let real: string;
    try {
      real = this.#real(path, false);
    } catch (error) {
      if (error instanceof FsError && error.code === "ELOOP") return null;
      throw error;
    }
    const node = this.#find(real);
    if (!node) return null;
    if (node.kind === "link") return { kind: "symlink", size: encode(node.target).length, mtime: node.mtime, mode: 0o777, target: node.target };
    return { kind: node.kind, size: node.kind === "file" ? node.data.length : 4096, mtime: node.mtime, mode: node.mode };
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.#real(from, false);
    const target = this.#real(to, false);
    if (target === source) return;
    if (target.startsWith(source + "/")) throw new FsError("EINVAL", to);
    const sourceParent = this.#directory(parentOf(source));
    const node = sourceParent.get(baseOf(source));
    if (!node) throw new FsError("ENOENT", from);
    const targetParent = this.#directory(parentOf(target));
    const existing = targetParent.get(baseOf(target));
    if (existing?.kind === "directory") throw new FsError("EISDIR", to);
    sourceParent.delete(baseOf(source));
    targetParent.set(baseOf(target), node);
  }
}

let breath = 0;

export function breathe(): Promise<void> | undefined {
  const now = Date.now();
  if (!breath) breath = now;
  if (now - breath < 40) return undefined;
  return new Promise<void>(resolve => setTimeout(() => {
    breath = Date.now();
    resolve();
  }, 0));
}
