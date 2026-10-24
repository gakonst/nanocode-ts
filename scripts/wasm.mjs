import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const outputs = ["nanocode_wasm.wasm", "interpreter.wasm", "models.js", "models.d.ts"];
export const manifestName = "nanocode-wasm.json";
export const repository = "gakonst/nanocode-ts";

function sources() {
  const files = ["sdk-revision.json", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "scripts/build.mjs", "scripts/wasm.mjs", "src/wasm/prelude.js", "interpreter/Cargo.toml", "interpreter/Cargo.lock"];
  for (const directory of ["src", "interpreter/src"]) {
    for (const file of readdirSync(join(root, directory), { recursive: true })) {
      const path = directory + "/" + String(file).split("\\").join("/");
      if (path.endsWith(".rs")) files.push(path);
    }
  }
  return [...new Set(files)].filter(path => existsSync(join(root, path))).sort();
}

export function fingerprint() {
  const digest = createHash("sha256");
  for (const path of sources()) {
    const bytes = readFileSync(join(root, path));
    digest.update(path + "\0" + bytes.length + "\0");
    digest.update(bytes);
  }
  return digest.digest("hex").slice(0, 20);
}

export const tag = print => "wasm-" + print;
export const assetName = print => "nanocode-wasm-" + print + ".tgz";
export const assetUrl = print => "https://github.com/" + repository + "/releases/download/" + tag(print) + "/" + assetName(print);
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function manifest(directory, print) {
  return { fingerprint: print, files: Object.fromEntries(outputs.map(name => [name, sha256(readFileSync(join(directory, name)))])) };
}

export function current(directory, print) {
  let recorded;
  try { recorded = JSON.parse(readFileSync(join(directory, manifestName), "utf8")); } catch { return false; }
  if (recorded?.fingerprint !== print) return false;
  return outputs.every(name => existsSync(join(directory, name)) && recorded.files?.[name] === sha256(readFileSync(join(directory, name))));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(fingerprint());
