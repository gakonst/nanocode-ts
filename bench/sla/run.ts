import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs'
import * as Path from 'node:path'

import { marks } from './fixture-marks.ts'

type Lane = {
  readonly env: (home: string, base: string) => NodeJS.ProcessEnv
  readonly exec?: (home: string, base: string, prompt: string) => readonly string[]
  readonly ready: string
  readonly resume?: (home: string, base: string) => readonly string[]
  readonly setup?: (home: string, cwd: string) => void
  readonly tui: (home: string, base: string) => readonly string[]
}

type Sample = { [key: string]: number | string | boolean | undefined }

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith('--' + name + '='))?.slice(name.length + 3) ?? fallback
const now = () => process.hrtime.bigint()
const ms = (a: bigint | string | undefined, b: bigint | string | undefined) => (a === undefined || b === undefined ? undefined : Number(BigInt(a) - BigInt(b)) / 1e6)
const sleep = (time: number) => new Promise((resolve) => setTimeout(resolve, time))

const root = Path.resolve(arg('out', 'output/bench/sla'))
const work = Path.join(root, 'work')
const samples = Number(arg('samples', '10'))
const turns = Number(arg('turns', '2'))
const tokens = Number(arg('tokens', '200'))
const rate = Number(arg('rate', '0'))
const ttft = Number(arg('ttft', '0'))
const tool = arg('tool', '0')
const mode = arg('mode', 'tui')
const label = arg('label', mode + '-t' + tokens + '-r' + rate + '-f' + ttft + '-tool' + tool)
const settle = Number(arg('settle', '1500'))
const live = process.argv.includes('--live')
const rejected = process.argv.includes('--rejected')
const keyed = process.argv.includes('--key')
const anthropicKey = (keyed ? process.env.ANTHROPIC_API_KEY : undefined) ?? 'sk-ant-invalid'
const claudeModel = arg('claude-model', 'claude-haiku-4-5')
const codexModel = arg('codex-model', 'gpt-6-luna')
const rows = 40
const cols = 120

const base = { HOME: '', LANG: 'C.UTF-8', PATH: process.env.PATH, TERM: 'xterm-256color', USER: process.env.USER }
const bins = {
  claude: process.env.CLAUDE_BIN ?? 'claude',
  codex: process.env.CODEX_BIN ?? 'codex',
  nc: process.env.NC_BIN ?? 'nanocode',
}

const lanes: { [name: string]: Lane } = {
  claude: {
    env: (home, url) => ({ ...base, ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: home + '/.claude', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_TELEMETRY: '1', HOME: home }),
    exec: (home, url, prompt) => [bins.claude, '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', prompt],
    ready: '\u276f',
    setup: (home, cwd) => {
      Fs.mkdirSync(home + '/.claude', { recursive: true })
      Fs.writeFileSync(home + '/.claude/.claude.json', JSON.stringify({ bypassPermissionsModeAccepted: true, customApiKeyResponses: { approved: ['fixture-key', anthropicKey.slice(-20)], rejected: [] }, hasCompletedOnboarding: true, projects: { [Fs.realpathSync(cwd)]: { hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true } } }))
      Fs.writeFileSync(home + '/.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(true)'] }, theme: 'dark' }))
    },
    tui: () => [bins.claude],
  },
  codex: {
    env: (home) => ({ ...base, BENCH_KEY: 'fixture-key', CODEX_HOME: home + '/.codex', HOME: home }),
    ready: 'bench/model',
    setup: (home, cwd) => {
      Fs.mkdirSync(home + '/.codex', { recursive: true })
      Fs.writeFileSync(home + '/.codex/config.toml', 'approval_policy = "never"\ncheck_for_update_on_startup = false\nsandbox_mode = "danger-full-access"\n\n[analytics]\nenabled = false\n\n[feedback]\nenabled = false\n\n[projects."' + cwd + '"]\ntrust_level = "trusted"\n')
    },
    tui: (home, url) => [bins.codex, '-c', 'model_provider="bench"', '-c', 'model_providers.bench={name="bench",base_url="' + url + '/v1",wire_api="responses",env_key="BENCH_KEY"}', '-m', 'bench/model'],
  },
  'live-claude': {
    env: () => ({ ...process.env, TERM: base.TERM }),
    ready: '\u276f',
    tui: () => [bins.claude, '--model', claudeModel],
  },
  'live-codex': {
    env: () => ({ ...process.env, TERM: base.TERM }),
    ready: '\u203a',
    tui: () => [bins.codex, '-m', codexModel],
  },
  'live-nc-claude': liveNcLane(bins.nc, claudeModel),
  'rejected-claude': {
    env: (home) => ({ ...base, ANTHROPIC_API_KEY: anthropicKey, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: home + '/.claude', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_TELEMETRY: '1', HOME: home }),
    ready: '\u276f',
    setup: (home, cwd) => lanes.claude!.setup!(home, cwd),
    tui: () => [bins.claude, '--model', claudeModel],
  },
  'live-nc-codex': liveNcLane(bins.nc, codexModel),
  nc: ncLane(bins.nc),
  'nc-claude': ncClaudeLane(bins.nc),
}

function ncLane(bin: string): Lane {
  return {
    env: (home) => ({ ...base, AI_GATEWAY_API_KEY: 'fixture-key', HOME: home, NANOCODE_TELEMETRY: 'off' }),
    exec: (home, url, prompt) => [bin, 'exec', '--home', home + '/.nanocode', '--gateway', 'vercel', '--gateway-base-url', url + '/v1', '-m', 'luna', '--ephemeral', prompt],
    ready: 'Ask anything',
    resume: (home, url) => [bin, '--home', home + '/.nanocode', '--gateway', 'vercel', '--gateway-base-url', url + '/v1', '-m', 'luna', '--continue'],
    tui: (home, url) => [bin, '--home', home + '/.nanocode', '--gateway', 'vercel', '--gateway-base-url', url + '/v1', '-m', 'luna', '--ephemeral'],
  }
}

function ncClaudeLane(bin: string): Lane {
  return {
    env: (home, url) => ({ ...base, HOME: home, NANOCODE_ANTHROPIC_API_KEY: 'fixture-key', NANOCODE_ANTHROPIC_BASE_URL: url + '/v1', NANOCODE_TELEMETRY: 'off' }),
    exec: (home, url, prompt) => [bin, 'exec', '--home', home + '/.nanocode', '-m', 'claude-opus-4-6', '--ephemeral', prompt],
    ready: 'Ask anything',
    tui: (home) => [bin, '--home', home + '/.nanocode', '-m', 'claude-opus-4-6', '--ephemeral'],
  }
}

function liveNcLane(bin: string, model: string): Lane {
  return {
    env: () => ({ ...process.env, NANOCODE_TELEMETRY: 'off', TERM: base.TERM }),
    ready: 'newsession',
    tui: () => [bin, '-m', model, '--ephemeral'],
  }
}

function rejectedLane(bin: string, kind: string): Lane {
  const env = kind === 'claude' ? { NANOCODE_ANTHROPIC_API_KEY: anthropicKey, NANOCODE_ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' } : { AI_GATEWAY_API_KEY: 'invalid' }
  const args = kind === 'claude' ? ['-m', claudeModel] : ['--gateway', 'vercel', '-m', 'luna']
  return {
    env: (home) => ({ ...base, ...env, HOME: home, NANOCODE_TELEMETRY: 'off' }),
    ready: 'Ask anything',
    tui: (home) => [bin, '--home', home + '/.nanocode', ...args, '--ephemeral'],
  }
}

function laneOf(name: string): Lane {
  const [kind, build] = name.split('@')
  const bin = build ? process.env['NC_BIN_' + build.toUpperCase()] : undefined
  if (build && !bin) throw new Error('NC_BIN_' + build.toUpperCase() + ' is not set')
  if (kind === 'nc' && bin) return ncLane(bin)
  if (kind === 'nc-claude' && bin) return ncClaudeLane(bin)
  if (kind === 'live-nc-claude' && bin) return liveNcLane(bin, claudeModel)
  if (kind === 'rejected-nc-claude' && bin) return rejectedLane(bin, 'claude')
  if (kind === 'rejected-nc-gateway' && bin) return rejectedLane(bin, 'gateway')
  if (kind === 'live-nc-codex' && bin) return liveNcLane(bin, codexModel)
  const lane = lanes[name]
  if (!lane) throw new Error('unknown lane ' + name)
  return lane
}

const replies: readonly [RegExp, (match: RegExpExecArray) => string][] = [
  [/\x1b\]11;\?(?:\x1b\\|\x07)/g, () => '\x1b]11;rgb:1d1d/1f1f/2121\x1b\\'],
  [/\x1b\]10;\?(?:\x1b\\|\x07)/g, () => '\x1b]10;rgb:e5e5/e5e5/e5e5\x1b\\'],
  [/\x1b\[6n/g, () => '\x1b[1;1R'],
  [/\x1b\[\?996n/g, () => '\x1b[?997;1n'],
  [/\x1b\[\?u/g, () => '\x1b[?0u'],
  [/\x1b\[>q/g, () => '\x1bP>|bench-term\x1b\\'],
  [/\x1b\[\?(\d+)\$p/g, (m) => '\x1b[?' + m[1] + ';2$y'],
  [/\x1b\[0?c/g, () => '\x1b[?62;22c'],
  [/\x1b\[18t/g, () => '\x1b[8;' + rows + ';' + cols + 't'],
  [/\x1b\[14t/g, () => '\x1b[4;' + rows * 20 + ';' + cols * 10 + 't'],
  [/\x1b\[16t/g, () => '\x1b[6;20;10t'],
]
const ansi = /\x1b\[[0-9;?<>=!]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]/g

const quote = (word: string) => "'" + word.replaceAll("'", "'\\''") + "'"

function terminal(command: readonly string[], env: NodeJS.ProcessEnv, cwd: string) {
  const line = 'stty rows ' + rows + ' cols ' + cols + ' 2>/dev/null; exec ' + command.map(quote).join(' ')
  const child = ChildProcess.spawn('script', ['-qfec', line, '/dev/null'], { cwd, detached: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const watches: { at?: bigint; resolve: (at: bigint) => void; text: string }[] = []
  let plain = ''
  let raw = ''
  child.stdout.on('data', (data: Buffer) => {
    const at = now()
    const chunk = data.toString('utf8')
    raw = (raw + chunk).slice(-4096)
    for (const [pattern, reply] of replies) {
      pattern.lastIndex = 0
      for (let m = pattern.exec(chunk); m; m = pattern.exec(chunk)) child.stdin.write(reply(m))
    }
    plain = (plain + chunk.replace(ansi, '')).slice(-65536)
    for (const watch of watches) if (watch.at === undefined && plain.includes(watch.text)) {
      watch.at = at
      watch.resolve(at)
    }
  })
  child.stderr.resume()
  return {
    child,
    kill() {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {}
    },
    plain: () => plain,
    reset() {
      plain = ''
    },
    wait(text: string, timeout: number) {
      return new Promise<bigint | undefined>((resolve) => {
        const watch = { resolve, text }
        watches.push(watch)
        if (plain.includes(text)) resolve(now())
        setTimeout(() => resolve(undefined), timeout)
      })
    },
    write: (text: string) => child.stdin.write(text),
  }
}

function fixture() {
  const child = ChildProcess.spawn(process.execPath, [Path.join(import.meta.dirname, 'fixture.ts')], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise<{ child: ChildProcess.ChildProcess; url: string }>((resolve) => child.stdout.once('data', (data: Buffer) => resolve({ child, url: 'http://127.0.0.1:' + JSON.parse(data.toString()).port })))
}

async function log(url: string, run: string) {
  return (await (await fetch(url + '/_log?run=' + run)).json()) as any[]
}

function derive(entries: any[], enter: bigint, seen: bigint | undefined, last: bigint | undefined): Sample {
  const main = entries.filter((entry) => entry.kind !== 'side')
  const text = main.find((entry) => entry.kind === 'text')
  const toolEntry = main.find((entry) => entry.kind === 'tool')
  const first = main[0]
  return {
    conn_age: first?.conn_age_ms,
    conn_new: first?.conn_new,
    e2e: ms(seen, enter),
    fixture: text ? ms(text.first_token_ns, first.arrive_ns) : undefined,
    overhead: text && seen ? ms(seen, enter)! - ms(text.first_token_ns, text.arrive_ns)! - (toolEntry ? ms(toolEntry.done_ns, toolEntry.arrive_ns)! : 0) : undefined,
    provider_tps: text && tokens > 1 ? (tokens - 1) / (ms(text.last_token_ns, text.first_token_ns)! / 1e3) : undefined,
    render: text && seen ? ms(seen, text.first_token_ns) : undefined,
    rendered_tps: seen && last && tokens > 1 ? (tokens - 1) / (ms(last, seen)! / 1e3) : undefined,
    request_bytes: first?.request_bytes,
    request_out: first ? ms(first.arrive_ns, enter) : undefined,
    requests: main.length,
    side: entries.length - main.length,
    tail: text && last ? ms(last, text.last_token_ns) : undefined,
    tool_rt: toolEntry && text ? ms(text.arrive_ns, toolEntry.done_ns) : undefined,
  }
}

async function tuiSample(name: string, lane: Lane, url: string, index: number): Promise<Sample[]> {
  const home = Path.join(work, name + '-' + index)
  const cwd = Path.join(work, 'ws')
  Fs.rmSync(home, { force: true, recursive: true })
  Fs.mkdirSync(home, { recursive: true })
  Fs.mkdirSync(cwd, { recursive: true })
  if (!live || rejected) lane.setup?.(home, cwd)
  const term = terminal(lane.tui(home, url), lane.env(home, url), cwd)
  const started = now()
  const ready = await term.wait(lane.ready, 30000)
  if (process.env.SLA_DEBUG) console.error(name, index, 'ready', ready !== undefined)
  const out: Sample[] = []
  if (!ready) {
    term.kill()
    return [{ error: 'not ready: ' + term.plain().slice(-400), lane: name }]
  }
  await sleep(settle)
  for (let turn = 1; turn <= turns; turn++) {
    const run = name.replace(/[^A-Za-z0-9]/g, '-') + '-' + index + '-' + turn + '-' + String(Math.random()).slice(2, 8)
    const mark = marks(turn)
    term.reset()
    const pair = mark.first.slice(0, 2)
    term.write(live ? "Reply with only the word formed by writing '" + pair + "' four times. (" + run + ')' : 'Reply SLA[run=' + run + ',turn=' + turn + ',tokens=' + tokens + ',rate=' + rate + ',ttft=' + ttft + ',tool=' + tool + ']')
    await sleep(200)
    const enter = now()
    term.write('\r')
    if (process.env.SLA_DEBUG) console.error(name, index, turn, 'enter')
    const seen = await term.wait(rejected && !keyed ? '401' : mark.first, Number(arg('timeout', '20000')))
    const last = seen && !live ? await term.wait(mark.last, Number(arg('timeout', '20000'))) : undefined
    if (process.env.SLA_DEBUG) console.error(name, index, turn, 'seen', seen !== undefined, 'last', last !== undefined)
    await sleep(300)
    const entries = live ? [] : await log(url, run)
    if (process.env.SLA_TRACE) Fs.appendFileSync(process.env.SLA_TRACE, JSON.stringify({ enter: String(enter), headers: String(entries.find((entry) => entry.kind !== 'side')?.headers_ns), lane: name, turn }) + '\n')
    out.push({ index, lane: name, ready: ms(ready, started), turn, ...(live ? { e2e: ms(seen, enter) } : derive(entries, enter, seen, last)), ...(seen ? {} : { error: 'no token: ' + term.plain().slice(-300) }) })
    await sleep(live ? 3000 : 500)
  }
  term.kill()
  return out
}

async function resumeSample(name: string, lane: Lane, url: string, index: number): Promise<Sample[]> {
  const home = Path.join(work, name + '-' + index)
  const cwd = Path.join(work, 'ws-' + name + '-' + index)
  Fs.rmSync(home, { force: true, recursive: true })
  Fs.rmSync(cwd, { force: true, recursive: true })
  Fs.mkdirSync(home, { recursive: true })
  Fs.mkdirSync(cwd, { recursive: true })
  const durable = lane.tui(home, url).filter((word) => word !== '--ephemeral')
  const first = terminal(durable, lane.env(home, url), cwd)
  if (!(await first.wait(lane.ready, 30000))) {
    first.kill()
    return [{ error: 'not ready: ' + first.plain().slice(-300), index, lane: name }]
  }
  await sleep(settle)
  const run = name.replace(/[^A-Za-z0-9]/g, '-') + '-' + index + '-resume-' + String(Math.random()).slice(2, 8)
  const mark = marks(1)
  first.write('Reply SLA[run=' + run + ',turn=1,tokens=' + tokens + ',rate=' + rate + ',ttft=0,tool=0]')
  await sleep(200)
  first.write('\r')
  if (!(await first.wait(mark.first, 20000))) {
    first.kill()
    return [{ error: 'no token before the crash', index, lane: name }]
  }
  await sleep(500)
  first.kill()
  const killed = now()
  const second = terminal(lane.resume!(home, url), lane.env(home, url), cwd)
  const ready = await second.wait(lane.ready, 30000)
  const restored = await second.wait(mark.first, 30000)
  let resumed: bigint | undefined
  for (let tries = 0; tries < 300 && resumed === undefined; tries++) {
    const main = (await log(url, run)).filter((entry) => entry.kind !== 'side')
    if (main.length > 1) resumed = BigInt(main[1].arrive_ns)
    else await sleep(50)
  }
  second.kill()
  return [{ index, lane: name, ready: ms(ready, killed), restored: ms(restored, killed), resumed_request: ms(resumed, killed), turn: 1, ...(restored ? {} : { error: 'transcript not restored: ' + second.plain().slice(-300) }) }]
}

async function execSample(name: string, lane: Lane, url: string, index: number): Promise<Sample[]> {
  const home = Path.join(work, name + '-' + index)
  const cwd = Path.join(work, 'ws')
  Fs.rmSync(home, { force: true, recursive: true })
  Fs.mkdirSync(home, { recursive: true })
  Fs.mkdirSync(cwd, { recursive: true })
  lane.setup?.(home, cwd)
  const run = name.replace(/[^A-Za-z0-9]/g, '-') + '-' + index + '-exec-' + String(Math.random()).slice(2, 8)
  const mark = marks(1)
  const command = lane.exec!(home, url, 'Reply SLA[run=' + run + ',turn=1,tokens=' + tokens + ',rate=' + rate + ',ttft=' + ttft + ',tool=' + tool + ']')
  const enter = now()
  const child = ChildProcess.spawn(command[0]!, command.slice(1), { cwd, env: lane.env(home, url), stdio: ['ignore', 'pipe', 'pipe'] })
  let seen: bigint | undefined
  let last: bigint | undefined
  let text = ''
  child.stdout.on('data', (data: Buffer) => {
    const at = now()
    text = (text + data.toString('utf8')).slice(-65536)
    if (!seen && text.includes(mark.first)) seen = at
    if (!last && text.includes(mark.last)) last = at
  })
  let stderr = ''
  child.stderr.on('data', (data: Buffer) => (stderr = (stderr + data.toString()).slice(-2000)))
  const exit = await new Promise<bigint>((resolve) => child.on('exit', () => resolve(now())))
  return [{ exit: ms(exit, enter), index, lane: name, turn: 1, ...derive(await log(url, run), enter, seen, last), ...(seen ? {} : { error: 'no token: ' + stderr.slice(-400) + text.slice(-200) }) }]
}

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

const names = arg('lanes', 'nc,claude,codex').split(',')
const fx = live ? { child: { kill: () => true }, url: '' } : await fixture()
const all: Sample[] = []
Fs.mkdirSync(root, { recursive: true })
for (let index = 0; index < samples; index++) {
  for (const name of index % 2 === 0 ? names : [...names].reverse()) {
    const lane = laneOf(name)
    const result = mode === 'exec' ? await execSample(name, lane, fx.url, index) : mode === 'resume' ? await resumeSample(name, lane, fx.url, index) : await tuiSample(name, lane, fx.url, index)
    all.push(...result)
    for (const sample of result) Fs.appendFileSync(Path.join(root, label + '.jsonl'), JSON.stringify(sample) + '\n')
    for (const sample of result) if (sample.error) console.error(name, index, sample.error)
  }
}
fx.child.kill()

const metrics = ['e2e', 'request_out', 'render', 'overhead', 'tool_rt', 'rendered_tps', 'provider_tps', 'tail', 'ready', 'restored', 'resumed_request', 'exit', 'conn_age', 'request_bytes']
const lines = ['# ' + label + ' (' + samples + ' samples, ' + new Date().toISOString() + ')', '', '| lane | turn | n | ' + metrics.map((m) => m + ' p50 / p99').join(' | ') + ' |', '|' + ' --- |'.repeat(metrics.length + 3)]
for (const name of names) {
  for (let turn = 1; turn <= (mode === 'tui' ? turns : 1); turn++) {
    const rows = all.filter((sample) => sample.lane === name && sample.turn === turn && !sample.error)
    const cells = metrics.map((metric) => {
      const values = rows.map((row) => row[metric]).filter((value): value is number => typeof value === 'number')
      if (!values.length) return '-'
      const digits = metric.endsWith('tps') || metric === 'request_bytes' ? 0 : 2
      return pct(values, 50)!.toFixed(digits) + ' / ' + pct(values, 99)!.toFixed(digits)
    })
    lines.push('| ' + name + ' | ' + turn + ' | ' + rows.length + ' | ' + cells.join(' | ') + ' |')
  }
}
Fs.appendFileSync(Path.join(root, 'REPORT.md'), lines.join('\n') + '\n\n')
console.log(lines.join('\n'))
process.exit(0)
