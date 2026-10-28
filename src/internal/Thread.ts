import type * as Contracts from '../Contracts.ts'
import * as AgentRuntime from '../AgentRuntime.ts'

type Port = {
  postMessage(message: unknown, transfer?: unknown[]): void
  once(event: string, listener: (value: any) => void): void
  unref?(): void
  close?(): void
}

type WorkerThreads = {
  Worker: new (
    source: string,
    options: {
      eval: true
      workerData: unknown
      transferList: unknown[]
      resourceLimits: { stackSizeMb: number }
    },
  ) => Port & { terminate(): Promise<number> }
  MessageChannel: new () => { port1: Port; port2: Port }
  receiveMessageOnPort(port: Port): { message: Reply } | undefined
}

type Call = [kind: 0 | 1 | 2 | 3, id: number, bytes?: Uint8Array, body?: Uint8Array]

type Reply = { calls: Call[]; error?: string; memory: number }

export type Options = { stackSizeMb?: number; timeoutMs?: number }

const SOURCE = (engine: string) => String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { port, module, signal } = workerData;
const flag = new Int32Array(signal);
const localEngine = ${engine};
let calls = [];
const host = {
  dispatch: (id, request, body) => calls.push([0, id, request.slice(), body]),
  cancel: id => calls.push([1, id]),
  reply: (id, bytes) => calls.push([2, id, bytes.slice()]),
  panicked: bytes => calls.push([3, 0, bytes.slice()]),
};
const answer = (reply) => {
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
};
localEngine(module, host).then(engine => {
  port.on("message", ({ call, id, data }) => {
    let error;
    try { engine.enter(call, id, data ? data.length : 0, data ? target => target.set(data) : null); }
    catch (thrown) { error = thrown instanceof Error ? thrown.message : String(thrown); }
    const sent = calls;
    calls = [];
    answer({ calls: sent, error, memory: engine.memoryBytes });
  });
  parentPort.postMessage({ calls: [], memory: engine.memoryBytes });
}, thrown => parentPort.postMessage({ calls: [], memory: 0, error: thrown instanceof Error ? thrown.message : String(thrown) }));
`

export function engine(options: Options = {}): Contracts.EngineFactory | undefined {
  const threads = (
    globalThis as { process?: { getBuiltinModule?(name: string): unknown } }
  ).process?.getBuiltinModule?.('node:worker_threads') as WorkerThreads | undefined
  if (!threads) return undefined
  return async (module, host) => start(threads, module, host, options)
}

async function start(
  threads: WorkerThreads,
  module: WebAssembly.Module,
  host: Contracts.EngineHost,
  options: Options,
): Promise<Contracts.Engine> {
  const signal = new SharedArrayBuffer(4)
  const flag = new Int32Array(signal)
  const { port1, port2 } = new threads.MessageChannel()
  const worker = new threads.Worker(SOURCE(AgentRuntime.localEngine.toString()), {
    eval: true,
    workerData: { port: port2, module, signal },
    transferList: [port2],
    resourceLimits: { stackSizeMb: options.stackSizeMb ?? 8 },
  })
  worker.unref?.()
  let failure: Error | undefined
  let exited = false
  worker.once('exit', () => {
    exited = true
    failure ??= new Error('the WASM engine thread exited')
  })
  worker.once('error', (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error))
  })
  const ready = await new Promise<Reply>((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('exit', () => reject(failure))
  })
  if (ready.error) {
    void worker.terminate()
    throw new Error(ready.error)
  }
  let memory = ready.memory
  const close = () => {
    if (exited) return
    exited = true
    failure ??= new Error('the WASM engine thread was closed')
    port1.close?.()
    void worker.terminate()
  }
  return {
    get memoryBytes() {
      return memory
    },
    enter(call, id, length, fill) {
      if (failure) throw failure
      const data = call && fill ? new Uint8Array(length) : undefined
      if (data && fill) fill(data)
      Atomics.store(flag, 0, 0)
      port1.postMessage({ call, id, data }, data ? [data.buffer] : [])
      if (Atomics.wait(flag, 0, 0, options.timeoutMs ?? 300_000) === 'timed-out') {
        failure = new Error('the WASM engine thread did not answer')
        close()
        throw failure
      }
      let received = threads.receiveMessageOnPort(port1)
      while (!received) received = threads.receiveMessageOnPort(port1)
      const reply = received.message
      memory = reply.memory
      for (const [kind, callId, bytes, body] of reply.calls) {
        if (kind === 0) host.dispatch(callId, bytes!, body)
        else if (kind === 1) host.cancel(callId)
        else if (kind === 2) host.reply(callId, bytes!)
        else host.panicked(bytes!)
      }
      if (reply.error !== undefined) throw new Error(reply.error)
    },
    close,
  }
}
