const callFetch = (input) => call("fetch", input);
const callBash = (input) => call("bash", input);
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const toBase64 = (bytes) => {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index], b = bytes[index + 1], c = bytes[index + 2];
    out += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : alphabet[c & 63];
  }
  return out;
};
const fromBase64 = (text) => {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let bits = 0, value = 0, at = 0;
  for (const character of clean) {
    value = ((value << 6) | alphabet.indexOf(character)) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes[at++] = (value >> bits) & 255; }
  }
  return bytes.subarray(0, at);
};
const utf8 = (text) => {
  const bytes = [];
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return new Uint8Array(bytes);
};
const fromUtf8 = (bytes) => {
  let out = "";
  for (let index = 0; index < bytes.length;) {
    const a = bytes[index++];
    let code = a;
    if (a >= 0xf0) code = ((a & 7) << 18) | ((bytes[index++] & 63) << 12) | ((bytes[index++] & 63) << 6) | (bytes[index++] & 63);
    else if (a >= 0xe0) code = ((a & 15) << 12) | ((bytes[index++] & 63) << 6) | (bytes[index++] & 63);
    else if (a >= 0xc0) code = ((a & 31) << 6) | (bytes[index++] & 63);
    out += String.fromCodePoint(code);
  }
  return out;
};
const headerList = (headers) => {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.map(([name, value]) => [String(name), String(value)]);
  if (typeof headers.entries === "function") return [...headers.entries()];
  return Object.entries(headers).map(([name, value]) => [name, String(value)]);
};
class Headers {
  constructor(init) { this.list = headerList(init).map(([name, value]) => [name.toLowerCase(), value]); }
  get(name) { const found = this.list.filter(([key]) => key === String(name).toLowerCase()); return found.length ? found.map(([, value]) => value).join(", ") : null; }
  has(name) { return this.get(name) !== null; }
  set(name, value) { this.delete(name); this.list.push([String(name).toLowerCase(), String(value)]); }
  append(name, value) { this.list.push([String(name).toLowerCase(), String(value)]); }
  delete(name) { this.list = this.list.filter(([key]) => key !== String(name).toLowerCase()); }
  entries() { return this.list[Symbol.iterator](); }
  keys() { return this.list.map(([key]) => key)[Symbol.iterator](); }
  values() { return this.list.map(([, value]) => value)[Symbol.iterator](); }
  forEach(callback) { for (const [key, value] of this.list) callback(value, key, this); }
  [Symbol.iterator]() { return this.entries(); }
}
class Response {
  constructor(reply) {
    this.status = reply.status;
    this.statusText = reply.status_text ?? "";
    this.ok = reply.status >= 200 && reply.status < 300;
    this.url = reply.url ?? "";
    this.headers = new Headers(reply.headers);
    this.encoded = reply.body_base64;
    this.body_ = reply.body;
    this.bodyUsed = false;
  }
  async text() { this.bodyUsed = true; return this.body_ ?? fromUtf8(fromBase64(this.encoded ?? "")); }
  async json() { return JSON.parse(await this.text()); }
  async arrayBuffer() { this.bodyUsed = true; const bytes = this.encoded !== undefined ? fromBase64(this.encoded) : utf8(this.body_ ?? ""); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
  async bytes() { return new Uint8Array(await this.arrayBuffer()); }
}
const fetch = async (input, init = {}) => {
  const request = typeof input === "object" && input !== null && input.url !== undefined ? input : { url: String(input) };
  const body = init.body ?? request.body;
  const message = { url: String(request.url), method: String(init.method ?? request.method ?? "GET").toUpperCase(), headers: Object.fromEntries(headerList(init.headers ?? request.headers)) };
  if (body instanceof ArrayBuffer) message.body_base64 = toBase64(new Uint8Array(body));
  else if (ArrayBuffer.isView(body)) message.body_base64 = toBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  else if (body !== undefined && body !== null) message.body = typeof body === "string" ? body : JSON.stringify(body);
  const reply = await callFetch(message).catch((error) => { throw new TypeError(typeof error === "string" ? error : error?.message ?? JSON.stringify(error)); });
  return new Response(reply);
};
const quote = (value) => {
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value) ?? "";
  return /^[\w@%+=:,.\/-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\''") + "'";
};
const run = async (script, stdin) => {
  const result = await callBash(stdin === undefined ? { script } : { script, stdin });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exit_code };
};
const bash = (script, ...values) => run(typeof script === "string" ? script : script.raw.reduce((out, part, index) => out + part + (index < values.length ? quote(values[index]) : ""), ""));
bash.readFile = async (path) => {
  const result = await run("cat -- " + quote(path));
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "cat exited with " + result.exitCode);
  return result.stdout;
};
bash.writeFile = async (path, content) => {
  const result = await run("mkdir -p -- \"$(dirname -- " + quote(path) + ")\" && cat > " + quote(path), String(content));
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "write exited with " + result.exitCode);
};
const callWasm = (input) => call("wasm", input).catch((error) => { throw new Error(typeof error === "string" ? error : error?.message ?? JSON.stringify(error)); });
const toWire = (value) => typeof value === "bigint" ? { bigint: String(value) } : value;
const fromWire = (value) => Array.isArray(value) ? value.map(fromWire) : value !== null && typeof value === "object" && typeof value.bigint === "string" ? BigInt(value.bigint) : value;
const wasmSource = (source) => {
  if (typeof source === "string") return { path: source };
  if (source instanceof Module) return source.input;
  if (source instanceof ArrayBuffer) return { module: toBase64(new Uint8Array(source)) };
  if (ArrayBuffer.isView(source)) return { module: toBase64(new Uint8Array(source.buffer, source.byteOffset, source.byteLength)) };
  if (Array.isArray(source)) return { module: toBase64(Uint8Array.from(source)) };
  throw new TypeError("expected WebAssembly bytes (Uint8Array or ArrayBuffer) or a file path");
};
class Module {
  constructor(source) { this.input = wasmSource(source); }
}
class Memory {
  constructor(id) { this.id = id; }
  get buffer() { throw new Error("memory lives in the host: use await memory.read(offset, length) and await memory.write(offset, bytes)"); }
  async read(offset = 0, length) { const reply = await callWasm({ op: "read", id: this.id, offset, ...(length === undefined ? {} : { length }) }); return fromBase64(reply.data); }
  async write(offset, bytes) { await callWasm({ op: "write", id: this.id, offset, data: toBase64(bytes instanceof Uint8Array ? bytes : typeof bytes === "string" ? utf8(bytes) : new Uint8Array(bytes)) }); }
  async grow(pages) { return (await callWasm({ op: "grow", id: this.id, pages })).previous; }
}
const exportsOf = (id, list) => {
  const exports = {};
  for (const entry of list) {
    if (entry.kind === "function") exports[entry.name] = async (...args) => fromWire((await callWasm({ op: "call", id, name: entry.name, args: args.map(toWire) })).result);
    else if (entry.kind === "memory") exports[entry.name] = new Memory(id);
  }
  return Object.freeze(exports);
};
class Instance {
  constructor(module) {
    const ready = callWasm({ op: "instantiate", ...wasmSource(module) });
    this.ready = ready.then((reply) => { this.id = reply.id; this.engine = reply.engine; this.exports = exportsOf(reply.id, reply.exports); return this; });
    this.ready.catch(() => {});
    this.exports = new Proxy({}, { get: (_, name) => typeof name !== "string" || name === "then" ? undefined : async (...args) => (await this.ready).exports[name](...args) });
  }
  async close() { await this.ready; await callWasm({ op: "drop", id: this.id }); }
}
const instantiate = async (source, imports) => {
  const instance = new Instance(source instanceof Module ? source : new Module(source));
  await instance.ready;
  return source instanceof Module ? instance : { module: source instanceof Module ? source : new Module(source), instance };
};
const WebAssembly = {
  Module,
  Instance,
  Memory,
  compile: async (source) => new Module(source),
  instantiate,
  compileStreaming: async (response) => new Module(new Uint8Array(await (await response).arrayBuffer())),
  instantiateStreaming: async (response, imports) => instantiate(new Uint8Array(await (await response).arrayBuffer()), imports),
  validate: (source) => { const input = wasmSource(source); const bytes = input.module ? fromBase64(input.module) : null; return !bytes || (bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d); },
};
const wasm = {
  run: async (source, args = [], options = {}) => {
    const reply = await callWasm({ op: "run", ...wasmSource(source), args: args.map(String), ...(options.stdin === undefined ? {} : { stdin: String(options.stdin) }), ...(options.env ? { env: options.env } : {}) });
    return { stdout: reply.stdout, stderr: reply.stderr, exitCode: reply.exit_code };
  },
  invoke: async (source, name, ...args) => fromWire((await callWasm({ op: "invoke", ...wasmSource(source), name, args: args.map(toWire) })).result),
  instantiate: async (source) => (await instantiate(source instanceof Module ? source : new Module(source))),
};
return { fetch, bash, Headers, Response, wasm, WebAssembly };
