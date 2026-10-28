import { readFileSync } from "node:fs";
import { connectHand } from "../src/index.ts";
import { Bash, MemoryFileSystem } from "../src/bash/index.ts";

const module = await WebAssembly.compile(readFileSync(process.env.NANOCODE_WASM_PATH ?? new URL("../dist/nanocode_wasm.wasm", import.meta.url)));
const shell = await Bash.create({ fs: new MemoryFileSystem(), cwd: "/workspace" });
const hand = await connectHand(module, { url: process.env.URL, token: process.env.TOKEN, name: "bench", workspace: shell.workspace(), cwd: shell.cwd });
await hand.closed;
