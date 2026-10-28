import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fingerprint } from "../src/fingerprint.ts";
import { snapshotPyodide } from "../src/bash/commands/pysnapshot.ts";

const require = createRequire(import.meta.url);
const root = new URL("..", import.meta.url).pathname;
const version = require("pyodide/package.json").version;
const out = root + "dist/pyodide/";
const stamp = version + ":" + fingerprint(readFileSync(new URL(import.meta.url))) + ":" + fingerprint(readFileSync(root + "src/fingerprint.ts")) + ":" + fingerprint(readFileSync(root + "src/bash/commands/pysnapshot.ts"));
const PART_BYTES = 8 * 1024 * 1024;
if (existsSync(out + "stamp") && readFileSync(out + "stamp", "utf8") === stamp) process.exit(0);

const PROBE = Buffer.from("AGFzbQEAAAABDANfAGAAAW9gAW8BfwMDAgECBygCE0pzdl9HZXRFcnJvcl9pbXBvcnQAAA5Kc3ZFcnJvcl9DaGVjawABChMCBwD7AQD7GwsJACAA+xr7FAAL", "base64");
const WORKLOAD = String.raw`
import os
os.environ["MPLBACKEND"] = "Agg"
import io, ctypes, sqlite3, decimal, hashlib, zlib, json
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image
import kiwisolver, contourpy
import pandas as pd
pd.DataFrame({"a": [1, 2]}).describe().to_csv(); pd.to_datetime(["2026-01-01"]); pd.DataFrame({"a":[1]}).groupby("a").sum()
x = np.linspace(0, 10, 50)
fig, ax = plt.subplots()
ax.plot(x, x ** 2)
ax.contourf(np.outer(x, x))
ax.hist(np.random.default_rng(0).normal(size=1000))
ax.scatter(x, np.sin(x))
fig.savefig(io.BytesIO(), format="png")
fig.savefig(io.BytesIO(), format="svg")
fig.savefig(io.BytesIO(), format="pdf")
Image.new("RGB", (8, 8)).save(io.BytesIO(), format="JPEG")
np.fft.fft(x); np.linalg.inv(np.eye(3)); np.random.random(10).sort()
ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int)(lambda v: v + 1)(1)
sqlite3.connect(":memory:").execute("select 1")
import micropip
await micropip.install(["tabulate", "cowsay"])
import tabulate, cowsay
`;

const seen = new Map();
const record = bytes => {
  if (bytes instanceof Compiled) return;
  const data = bytes instanceof Uint8Array ? bytes : ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  const key = fingerprint(data);
  if (!seen.has(key)) seen.set(key, Buffer.from(data));
};
const Compiled = WebAssembly.Module;
const instantiate = WebAssembly.instantiate;
const compile = WebAssembly.compile;
function Module(bytes) {
  record(bytes);
  return new Compiled(bytes);
}
Object.assign(Module, { customSections: Compiled.customSections, imports: Compiled.imports, exports: Compiled.exports });
Module.prototype = Compiled.prototype;
WebAssembly.Module = Module;
WebAssembly.instantiate = (bytes, imports) => (record(bytes), instantiate(bytes, imports));
WebAssembly.compile = bytes => (record(bytes), compile(bytes));
WebAssembly.instantiateStreaming = async (response, imports) => WebAssembly.instantiate(new Uint8Array(await (await response).arrayBuffer()), imports);

const { loadPyodide } = await import("pyodide");
const pyodide = await loadPyodide({ packageCacheDir: root + "target/pyodide-cache/", stdout: () => {}, stderr: () => {} });
await pyodide.loadPackage(["numpy", "matplotlib", "pandas", "micropip"], { messageCallback: () => {} });
await pyodide.runPythonAsync(WORKLOAD);
const types = ["i", "j", "f", "d"];
const params = [""];
for (let length = 1; length <= 3; length++) for (const prefix of params.filter(p => p.length === length - 1)) for (const type of types) params.push(prefix + type);
for (const result of ["v", ...types]) for (const list of params) {
  try {
    pyodide._module.addFunction(() => 0, result + list);
  } catch {}
}
record(PROBE);
WebAssembly.Module = Compiled;
WebAssembly.instantiate = instantiate;
WebAssembly.compile = compile;

const asm = (await import("pyodide/pyodide.asm.mjs")).default;
const made = await snapshotPyodide({ loadPyodide, createPyodideModule: asm }, { packageCacheDir: root + "target/pyodide-cache/", stdout: () => {}, stderr: () => {} }, version);
for (const [, key] of made.meta.libs) if (!seen.has(key)) throw new Error("the snapshot preloads " + key + ", which was not recorded");
const packed = Buffer.concat(made.chunks.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));

const main = [...seen].reduce((best, entry) => entry[1].length > best[1].length ? entry : best);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const imports = [], entries = [];
for (const [key, bytes] of seen) {
  const name = "m_" + key.replace("-", "_");
  writeFileSync(out + name + ".wasm", bytes);
  imports.push("import " + name + " from \"./" + name + ".wasm\";");
  entries.push(JSON.stringify(key) + ": " + name + ",");
  if (key === main[0]) entries.push(JSON.stringify(fingerprint(new TextEncoder().encode("nanocode-pyodide:" + version))) + ": " + name + ",");
}
mkdirSync(out + "snapshot");
const parts = [];
for (let offset = 0; offset < packed.length; offset += PART_BYTES) {
  const name = "part-" + parts.length + ".bin";
  writeFileSync(out + "snapshot/" + name, packed.subarray(offset, offset + PART_BYTES));
  parts.push(name);
}
writeFileSync(out + "modules.js", imports.join("\n") + "\nexport const PYODIDE_VERSION = " + JSON.stringify(version) + ";\nexport const SNAPSHOT = " + JSON.stringify({ parts, bytes: packed.length }) + ";\nexport const MODULES = {\n" + entries.join("\n") + "\n};\n");
writeFileSync(out + "modules.d.ts", "export declare const PYODIDE_VERSION: string;\nexport declare const SNAPSHOT: { parts: string[]; bytes: number };\nexport declare const MODULES: Record<string, WebAssembly.Module>;\n");
writeFileSync(out + "stamp", stamp);
const total = [...seen.values()].reduce((sum, bytes) => sum + bytes.length, 0);
console.log("pyodide " + version + ": " + seen.size + " precompiled modules, " + (total / 1048576).toFixed(1) + " MiB; snapshot of " + made.meta.packages.length + " packages in " + parts.length + " parts, " + (packed.length / 1048576).toFixed(1) + " MiB");

