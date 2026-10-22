export type FileKind = "file" | "directory";

export type FileStat = { kind: FileKind; size: number; mtime: number; mode: number };

export interface FileSystem {
  stat(path: string): Promise<FileStat | null>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, append?: boolean): Promise<void>;
  list(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export type FileInput = string | Uint8Array;

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
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
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

type Node = { kind: "file"; data: Uint8Array; mtime: number; mode: number } | { kind: "directory"; children: Map<string, Node>; mtime: number; mode: number };

export class MemoryFileSystem implements FileSystem {
  #root: Node = { kind: "directory", children: new Map(), mtime: Date.now(), mode: 0o755 };
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

  #directory(path: string): Map<string, Node> {
    const node = this.#find(path);
    if (!node) throw new FsError("ENOENT", path);
    if (node.kind !== "directory") throw new FsError("ENOTDIR", path);
    return node.children;
  }

  async stat(path: string): Promise<FileStat | null> {
    const node = this.#find(path);
    if (!node) return null;
    return { kind: node.kind, size: node.kind === "file" ? node.data.length : 4096, mtime: node.mtime, mode: node.mode };
  }

  async read(path: string): Promise<Uint8Array> {
    const node = this.#find(path);
    if (!node) throw new FsError("ENOENT", path);
    if (node.kind !== "file") throw new FsError("EISDIR", path);
    return node.data;
  }

  async write(path: string, data: Uint8Array, append = false): Promise<void> {
    const target = normalize(path);
    const parent = this.#directory(parentOf(target));
    const name = baseOf(target);
    if (!name) throw new FsError("EISDIR", path);
    const existing = parent.get(name);
    if (existing?.kind === "directory") throw new FsError("EISDIR", path);
    let bytes = data;
    if (append && existing) {
      bytes = new Uint8Array(existing.data.length + data.length);
      bytes.set(existing.data);
      bytes.set(data, existing.data.length);
    }
    if (bytes.length > this.maxFileBytes) throw new FsError("EFBIG", path);
    parent.set(name, { kind: "file", data: bytes, mtime: Date.now(), mode: existing?.mode ?? 0o644 });
  }

  async list(path: string): Promise<string[]> {
    return [...this.#directory(path).keys()].sort();
  }

  async mkdir(path: string): Promise<void> {
    const target = normalize(path);
    const parent = this.#directory(parentOf(target));
    if (parent.has(baseOf(target))) throw new FsError("EEXIST", path);
    parent.set(baseOf(target), { kind: "directory", children: new Map(), mtime: Date.now(), mode: 0o755 });
  }

  async remove(path: string): Promise<void> {
    const target = normalize(path);
    if (target === "/") throw new FsError("EINVAL", path);
    const parent = this.#directory(parentOf(target));
    const node = parent.get(baseOf(target));
    if (!node) throw new FsError("ENOENT", path);
    if (node.kind === "directory" && node.children.size) throw new FsError("ENOTEMPTY", path);
    parent.delete(baseOf(target));
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalize(from);
    const target = normalize(to);
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
