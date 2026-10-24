import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { arch, platform } from "node:os";
import { fingerprint as wasmFingerprint, manifest, manifestName } from "./wasm.mjs";

function fields(path, start, pattern) {
  const source = readFileSync(path, "utf8");
  const body = source.slice(source.indexOf(start) + start.length);
  return new Set([...body.slice(0, body.indexOf("\n}")).matchAll(pattern)].map(match => match[1]));
}
const rust = fields("src/wasm.rs", "struct Configuration {", /^\s+(\w+):/gm);
const typescript = fields("src/contracts.ts", "export type AgentConfiguration = {", /^\s+(\w+)\??:/gm);
for (const field of ["runtime_id", "started_ms"]) typescript.add(field);
const differing = [...rust].filter(field => !typescript.has(field)).concat([...typescript].filter(field => !rust.has(field)));
if (differing.length > 0 || rust.size === 0) {
  console.error(`AgentConfiguration in src/contracts.ts and Configuration in src/wasm.rs differ: ${differing.join(", ") || "no fields found"}`);
  process.exit(1);
}

const WASI_SDK = "25.0";
let wasiSdk = process.env.WASI_SDK_PATH;
if (!wasiSdk) {
  wasiSdk = join(process.cwd(), "target", "wasi-sdk-" + WASI_SDK);
  if (!existsSync(join(wasiSdk, "bin", "clang"))) {
    const host = (arch() === "arm64" ? "arm64" : "x86_64") + "-" + (platform() === "darwin" ? "macos" : "linux");
    const url = "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-" + WASI_SDK.split(".")[0] + "/wasi-sdk-" + WASI_SDK + "-" + host + ".tar.gz";
    mkdirSync(wasiSdk, { recursive: true });
    const fetched = spawnSync("sh", ["-c", 'curl -sSfL "$0" | tar xz --strip-components 1 -C "$1"', url, wasiSdk], { stdio: "inherit" });
    if (fetched.status !== 0) process.exit(fetched.status ?? 1);
  }
}
const sysroot = join(wasiSdk, "share", "wasi-sysroot");
const cflags = "--target=wasm32-wasip1 --sysroot=" + sysroot;
process.env.CC_wasm32_unknown_unknown ??= join(wasiSdk, "bin", "clang");
process.env.AR_wasm32_unknown_unknown ??= join(wasiSdk, "bin", "ar");
process.env.CFLAGS_wasm32_unknown_unknown ??= cflags + " -DEMSCRIPTEN=1 -DFE_DOWNWARD=0 -DFE_UPWARD=0 -include " + join(process.cwd(), "..", "nanocodex", "crates", "runtime", "code-mode-engine", "wasm", "quickjs-wasi.h");
process.env.BINDGEN_EXTRA_CLANG_ARGS_wasm32_unknown_unknown ??= cflags + " -fvisibility=default";
process.env.WASI_SYSROOT ??= sysroot;

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
for (const file of readdirSync("src", { recursive: true }).filter(file => file.endsWith(".rs")).sort()) include(join("src", file));
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
const artifactDigest = () => createHash("sha256").update(readFileSync(artifact)).digest("hex");
if (previousBuild?.inputs !== fingerprint || !existsSync(artifact) || previousBuild.artifact !== artifactDigest()) {
  const result = spawnSync("cargo", ["build", "--locked", "--lib", "--target", "wasm32-unknown-unknown", "--profile", "wasm"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  mkdirSync("output", { recursive: true });
  writeFileSync("output/wasm-build-fingerprint", JSON.stringify({ inputs: fingerprint, artifact: artifactDigest() }));
}
mkdirSync("dist", { recursive: true });
const bytes = readFileSync(artifact);
let previous;
try { previous = readFileSync("dist/nanocode_wasm.wasm"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!previous?.equals(bytes)) writeFileSync("dist/nanocode_wasm.wasm", bytes);

const interpreter = spawnSync("cargo", ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", "../target/interpreter"], { cwd: "interpreter", stdio: "inherit" });
if (interpreter.error) throw interpreter.error;
if (interpreter.status !== 0) process.exit(interpreter.status ?? 1);
const interpreterBytes = readFileSync("target/interpreter/wasm32-unknown-unknown/release/nanocode_interpreter.wasm");
let previousInterpreter;
try { previousInterpreter = readFileSync("dist/interpreter.wasm"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!previousInterpreter?.equals(interpreterBytes)) writeFileSync("dist/interpreter.wasm", interpreterBytes);

const { AgentRuntime } = await import("../src/index.ts");
const runtime = await AgentRuntime.instantiate(await WebAssembly.compile(bytes), { transaction() { throw new Error("the model catalog runs no SQL"); } }, { published() {} });
const catalog = await runtime.modelCatalog();
await runtime.dispose();
writeFileSync("dist/models.js", `export const models = ${JSON.stringify(catalog, null, 2)};\n`);
writeFileSync("dist/models.d.ts", `import type { ModelCatalog } from "./contracts.js";\nexport declare const models: ModelCatalog;\n`);
writeFileSync("dist/" + manifestName, JSON.stringify(manifest("dist", wasmFingerprint()), null, 2) + "\n");
