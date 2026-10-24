import { Readable } from "node:stream";
import { Sandbox, type NetworkPolicy, type SandboxRegion } from "@vercel/sandbox";
import type { WorkspaceHost } from "../contracts.ts";
import { collector, resolvePath, SANDBOX_CWD, SANDBOX_OUTPUT_LIMIT_BYTES, sandboxInstructions, shellOutput, timeoutArgv } from "./shell.ts";

export type VercelSandboxOptions = {
  name: string;
  credentials?: { token: string; projectId: string; teamId: string };
  cwd?: string;
  env?: Record<string, string>;
  files?: Record<string, string>;
  image?: string;
  instructions?: string;
  leaseMs?: number;
  networkPolicy?: NetworkPolicy;
  outputLimit?: number;
  persistent?: boolean;
  region?: SandboxRegion;
  tags?: Record<string, string>;
  vcpus?: number;
};

export type VercelSandboxWorkspace = WorkspaceHost & { sandbox(): Promise<Sandbox>; stop(): Promise<void> };

export const VERCEL_SANDBOX_LEASE_MS = 5 * 60_000;

export const VERCEL_SANDBOX_INSTRUCTIONS = sandboxInstructions("a Vercel Sandbox, a Firecracker microVM running Ubuntu with Node.js, Python 3, git and passwordless sudo (`sudo apt-get install -y PKG` adds system packages, `pip install --user PKG` Python ones)");

export function vercelSandbox(options: VercelSandboxOptions): VercelSandboxWorkspace {
  const cwd = options.cwd ?? SANDBOX_CWD;
  const lease = options.leaseMs ?? VERCEL_SANDBOX_LEASE_MS;
  const limit = options.outputLimit ?? SANDBOX_OUTPUT_LIMIT_BYTES;
  let opening: Promise<Sandbox> | undefined;

  const prepare = async (sandbox: Sandbox) => {
    const user = await sandbox.getDefaultUser();
    await sandbox.runCommand({ cmd: "bash", args: ["-c", 'mkdir -p "$1" && chown "$2" "$1"', "bash", cwd, user.username + ":" + user.group], sudo: true });
    const files = Object.entries(options.files ?? {});
    if (files.length) await sandbox.writeFiles(files.map(([path, content]) => ({ path: resolvePath(cwd, path), content })));
  };

  const open = () => opening ??= Sandbox.getOrCreate({
    name: options.name,
    ...options.credentials,
    timeout: lease,
    persistent: options.persistent ?? true,
    ...(options.image ? { image: options.image } : {}),
    ...(options.vcpus ? { resources: { vcpus: options.vcpus } } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.tags ? { tags: options.tags } : {}),
    ...(options.networkPolicy ? { networkPolicy: options.networkPolicy } : {}),
    ...(options.region ? { region: options.region } : {}),
    onCreate: prepare,
  }).catch(error => {
    opening = undefined;
    throw error;
  });

  const hold = async (sandbox: Sandbox, extra: number) => {
    const expires = sandbox.expiresAt?.getTime();
    if (expires === undefined || expires <= Date.now()) return;
    const short = Date.now() + lease + extra - expires;
    if (short > 1000) await sandbox.extendTimeout(short).catch(() => {});
  };

  const ready = async (extra = 0) => {
    const sandbox = await open();
    await hold(sandbox, extra);
    return sandbox;
  };

  return {
    instructions: options.instructions ?? VERCEL_SANDBOX_INSTRUCTIONS,
    sandbox: () => open(),
    stop: async () => {
      const current = opening;
      opening = undefined;
      if (current) await (await current).stop();
    },
    read: async path => {
      const sandbox = await ready();
      const buffer = await sandbox.readFileToBuffer({ path: resolvePath(cwd, path) });
      return buffer === null ? null : new TextDecoder().decode(buffer);
    },
    write: async (path, contents) => {
      const sandbox = await ready();
      const target = resolvePath(cwd, path);
      await sandbox.fs.mkdir(target.slice(0, target.lastIndexOf("/")) || "/", { recursive: true });
      await sandbox.writeFiles([{ path: target, content: contents }]);
    },
    remove: async path => {
      const sandbox = await ready();
      await sandbox.fs.rm(resolvePath(cwd, path), { recursive: true, force: true });
    },
    run: async (request, signal) => {
      const sandbox = await ready(request.timeout_ms ?? 0);
      const stdout = collector(limit);
      const stderr = collector(limit);
      const started = Date.now();
      const [cmd, ...args] = timeoutArgv(request.command, request.timeout_ms);
      const command = await sandbox.runCommand({
        cmd: cmd!,
        args,
        cwd: resolvePath(cwd, request.cwd || cwd),
        detached: true,
        ...(request.stdin !== undefined ? { stdin: Readable.from([Buffer.from(request.stdin)]) } : {}),
        signal,
      });
      const kill = () => void command.kill("SIGTERM").catch(() => {});
      signal.addEventListener("abort", kill, { once: true });
      const keep = setInterval(() => void hold(sandbox, 0), Math.max(lease / 2, 10_000));
      try {
        for await (const line of command.logs()) (line.stream === "stdout" ? stdout : stderr).push(line.data);
        const done = await command.wait();
        return shellOutput(stdout, stderr, done.exitCode, request.timeout_ms, Date.now() - started);
      } finally {
        clearInterval(keep);
        signal.removeEventListener("abort", kill);
      }
    },
  };
}
