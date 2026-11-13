import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { arch, platform } from "node:os";
import { fingerprint as wasmFingerprint, manifest, manifestName } from "./wasm.mjs";
import { build as buildPsh } from "./psh.mjs";
import { bake as bakePython, build as buildPython } from "./python.mjs";

function fields(path, start, pattern) {
  const source = readFileSync(path, "utf8");
  const body = source.slice(source.indexOf(start) + start.length);
  return new Set([...body.slice(0, body.indexOf("\n}")).matchAll(pattern)].map(match => match[1]));
}
const rust = fields("src/wasm.rs", "struct Configuration {", /^\s+(\w+):/gm);
const typescript = fields("src/Contracts.ts", "export type AgentConfiguration = {", /^\s+(\w+)\??:/gm);
for (const field of ["runtime_id", "started_ms", "code_mode"]) typescript.add(field);
const differing = [...rust].filter(field => !typescript.has(field)).concat([...typescript].filter(field => !rust.has(field)));
if (differing.length > 0 || rust.size === 0) {
  console.error(`AgentConfiguration in src/Contracts.ts and Configuration in src/wasm.rs differ: ${differing.join(", ") || "no fields found"}`);
  process.exit(1);
}

const BINARYEN = "133";
const binaryenDigests = {
  "aarch64-linux": "89c07ea56faf38d0fbecf36ca8ec0721756716185f265b568e133d427f299bf8",
  "arm64-macos": "ad66da82ac13f163e424b1643f16c6dfcccc98b5966296b43e52d3cab04f84a8",
  "x86_64-linux": "2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489",
  "x86_64-macos": "13a9b90be775c6389ce3d1f879cb8627bea56708ba8c122983941d53a8199b95",
};
let binaryen = process.env.BINARYEN_PATH;
if (!binaryen) {
  binaryen = join(process.cwd(), "target", "binaryen-version_" + BINARYEN);
  if (!existsSync(join(binaryen, "bin", "wasm-opt"))) {
    const host = platform() === "darwin" ? (arch() === "arm64" ? "arm64" : "x86_64") + "-macos" : (arch() === "arm64" ? "aarch64" : "x86_64") + "-linux";
    const url = "https://github.com/WebAssembly/binaryen/releases/download/version_" + BINARYEN + "/binaryen-version_" + BINARYEN + "-" + host + ".tar.gz";
    const fetched = spawnSync("curl", ["-sSfL", url], { maxBuffer: 1 << 28 });
    if (fetched.error) throw fetched.error;
    if (fetched.status !== 0) process.exit(fetched.status ?? 1);
    if (createHash("sha256").update(fetched.stdout).digest("hex") !== binaryenDigests[host]) {
      console.error("binaryen " + BINARYEN + " for " + host + " does not match its pinned SHA-256");
      process.exit(1);
    }
    mkdirSync(binaryen, { recursive: true });
    const unpacked = spawnSync("tar", ["xz", "--strip-components", "1", "-C", binaryen], { input: fetched.stdout, stdio: ["pipe", "inherit", "inherit"] });
    if (unpacked.status !== 0) process.exit(unpacked.status ?? 1);
  }
}
const wasmFeatures = ["--enable-bulk-memory", "--enable-bulk-memory-opt", "--enable-multivalue", "--enable-mutable-globals", "--enable-nontrapping-float-to-int", "--enable-reference-types", "--enable-sign-ext", "--enable-simd"];
const oneCallerInlineMaxSize = 100;
function optimize(input, output, flags = ["-O1"]) {
  const result = spawnSync(join(binaryen, "bin", "wasm-opt"), [...flags, ...wasmFeatures, input, "-o", output], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const digest = createHash("sha256");
function include(path) {
  digest.update(path);
  digest.update(readFileSync(path));
}
function directory(path) {
  for (const file of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (["target", "node_modules", ".git", "output", "dist"].includes(file.name)) continue;
    const child = join(path, file.name);
    if (file.isDirectory()) directory(child);
    else if (file.isFile()) include(child);
  }
}
for (const file of ["Cargo.toml", "Cargo.lock", "scripts/build.mjs", "src/wasm/prelude.js", "../nanocodex/Cargo.toml", "../nanocodex/Cargo.lock"]) include(file);
for (const root of [".", "../nanocodex"]) for (const name of ["rust-toolchain", "rust-toolchain.toml", ".cargo/config", ".cargo/config.toml", "build.rs"]) if (existsSync(join(root, name))) include(join(root, name));
for (const file of readdirSync("src", { recursive: true }).filter(file => file.endsWith(".rs") || /^wasm[\\/].*\.js$/.test(file)).sort()) include(join("src", file));
directory("../nanocodex/crates");
const compiler = spawnSync("rustc", ["--version", "--verbose"], { encoding: "utf8" });
if (compiler.error) throw compiler.error;
if (compiler.status !== 0) process.exit(compiler.status ?? 1);
digest.update(compiler.stdout);
digest.update(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("CARGO_") || key.startsWith("RUST")))));
const fingerprint = digest.digest("hex");
const artifact = "target/wasm32-unknown-unknown/wasm/nanocode_wasm.wasm";
let previousBuild;
try { previousBuild = JSON.parse(readFileSync("output/wasm-build-fingerprint", "utf8")); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
const optimized = "target/wasm32-unknown-unknown/wasm/nanocode_wasm.opt.wasm";
const fileDigest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
let built = false;
if (previousBuild?.inputs !== fingerprint || !existsSync(artifact) || previousBuild.artifact !== fileDigest(artifact)) {
  const result = spawnSync("cargo", ["build", "--locked", "--lib", "--target", "wasm32-unknown-unknown", "--profile", "wasm"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  built = true;
}
if (built || !existsSync(optimized) || previousBuild?.optimized !== fileDigest(optimized)) {
  optimize(artifact, optimized, ["-O3", "--one-caller-inline-max-function-size=" + oneCallerInlineMaxSize]);
  mkdirSync("output", { recursive: true });
  writeFileSync("output/wasm-build-fingerprint", JSON.stringify({ inputs: fingerprint, artifact: fileDigest(artifact), optimized: fileDigest(optimized) }));
}
mkdirSync("dist", { recursive: true });
const bytes = readFileSync(optimized);
let previous;
try { previous = readFileSync("dist/nanocode_wasm.wasm"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!previous?.equals(bytes)) writeFileSync("dist/nanocode_wasm.wasm", bytes);

const interpreter = spawnSync("cargo", ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", "../target/interpreter"], { cwd: "interpreter", stdio: "inherit" });
if (interpreter.error) throw interpreter.error;
if (interpreter.status !== 0) process.exit(interpreter.status ?? 1);
optimize("target/interpreter/wasm32-unknown-unknown/release/nanocode_interpreter.wasm", "target/interpreter/wasm32-unknown-unknown/release/nanocode_interpreter.opt.wasm");
const interpreterBytes = readFileSync("target/interpreter/wasm32-unknown-unknown/release/nanocode_interpreter.opt.wasm");
let previousInterpreter;
try { previousInterpreter = readFileSync("dist/interpreter.wasm"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!previousInterpreter?.equals(interpreterBytes)) writeFileSync("dist/interpreter.wasm", interpreterBytes);

const psh = buildPsh();
optimize(psh, "target/psh/psh.opt.wasm");
const pshBytes = readFileSync("target/psh/psh.opt.wasm");
let previousPsh;
try { previousPsh = readFileSync("dist/psh.wasm"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!previousPsh?.equals(pshBytes)) writeFileSync("dist/psh.wasm", pshBytes);

optimize(buildPython(), "target/python/python.opt.wasm", ["-Oz"]);
const pythonBytes = bakePython(readFileSync("target/python/python.opt.wasm"));
let previousPython;
try { previousPython = readFileSync("dist/python.wasm"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!previousPython?.equals(pythonBytes)) writeFileSync("dist/python.wasm", pythonBytes);

const { AgentRuntime } = await import("../src/index.ts");
const runtime = await AgentRuntime.instantiate(await WebAssembly.compile(bytes), { transaction() { throw new Error("the model catalog runs no SQL"); } }, { published() {} });
const catalog = await runtime.modelCatalog();
await runtime.dispose();
writeFileSync("dist/models.js", `export const models = ${JSON.stringify(catalog, null, 2)};\n`);
writeFileSync("dist/models.d.ts", `import type { ModelCatalog } from "./Contracts.js";\nexport declare const models: ModelCatalog;\n`);
writeFileSync("dist/" + manifestName, JSON.stringify(manifest("dist", wasmFingerprint()), null, 2) + "\n");
