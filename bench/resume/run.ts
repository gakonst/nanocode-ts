import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { lanes, shapes } from './lanes.ts'
import * as Lib from './lib.ts'

const running = /Script running with cell ID (\d+)/
const unknown = /outcome unknown|interrupted by a host crash/i

function label(round) {
  return round
    .map((action) =>
      action.exec
        ? 'exec ' + action.exec
        : action.wait
          ? 'wait ' + action.wait
          : action.spawn
            ? 'spawn ' + action.spawn
            : action.join
              ? 'join ' + action.join
              : action.code
                ? 'code ' + action.code
                : '?',
    )
    .join('+')
}

function command(action) {
  return (
    'echo ' +
    action.exec +
    ' >> steps.log' +
    (action.sleep ? '; sleep ' + action.sleep : '') +
    '; echo ' +
    action.exec +
    ' >> ends.log; cat steps.log | tr "\\n" " "'
  )
}

function script(rounds, prefix, anomalies) {
  const marks = new Map()
  let total = 0
  const starts = rounds.map((round) => {
    const start = total
    for (const [index, action] of round.entries())
      marks.set(action.exec ?? action.code ?? '#' + (start + index), start + index)
    total += round.length
    return start
  })
  return (view) => {
    const done = view.calls.length
    if (done === total) return { final: 'The task is complete.', label: prefix + 'final' }
    const at = starts.indexOf(done)
    if (at < 0) {
      anomalies.push(prefix + 'a request with ' + done + ' calls matches no round')
      return { final: 'ANOMALY', label: prefix + 'anomaly ' + done }
    }
    const calls = rounds[at].map((action) => {
      if (action.exec)
        return {
          input: {
            code:
              'const result = await tools.Bash({ command: ' +
              JSON.stringify(command(action)) +
              ' }); text(result.stdout)',
          },
          name: 'exec',
        }
      if (action.code) return { input: { code: action.source(view) }, name: 'exec' }
      if (action.wait) {
        const earlier = view.calls.filter((call) => running.test(call.output ?? ''))
        const origin = view.calls[marks.get(action.wait)]
        let cell
        for (const call of earlier) {
          const follows =
            call === origin || (call.name === 'wait' && String(call.input?.cell_id) === cell)
          if (follows) cell = running.exec(call.output)[1]
        }
        if (cell === undefined) {
          anomalies.push(
            prefix +
              'wait ' +
              action.wait +
              ': the cell was not reported as running: ' +
              JSON.stringify(origin?.output ?? null).slice(0, 200),
          )
          return { input: { cell_id: '0', yield_time_ms: 1000 }, name: 'wait' }
        }
        return { input: { cell_id: cell, yield_time_ms: 60_000 }, name: 'wait' }
      }
      throw new Error('unknown action ' + JSON.stringify(action))
    })
    return { calls, label: prefix + label(rounds[at]) }
  }
}

export async function run(lane, shapeName, options) {
  const shape = shapes[shapeName]
  const { out, port } = options
  Fs.rmSync(out, { force: true, recursive: true })
  Fs.mkdirSync(out, { recursive: true })
  const work = Path.join(out, 'work')
  Fs.mkdirSync(work, { recursive: true })
  const anomalies = []
  const main = script(lane.rounds, '', anomalies)
  const child = lane.child ? script(lane.child, 'sub:', anomalies) : undefined
  const endpoint = await Lib.startModel({
    answerDelayMs: lane.answerDelayMs ?? 300,
    decide: (view, context) => {
      const sub = child && view.prompt.includes('SUBAGENT-TASK')
      const step = (sub ? child : main)(view, context)
      return step
    },
    out,
    websocket: shape.websocket,
  })
  const vars = {
    ACCESS_TOKEN: 'harness-token',
    CELL_YIELD_MS: String(lane.yieldMs ?? 3000),
    MODEL_URL: endpoint.url,
    ...(shape.websocket ? { SUBSCRIPTION: 'true' } : {}),
    ...lane.vars,
  }
  const started = Date.now()
  let worker = await Lib.startWorker({ out, port, vars })
  const api = Lib.client(worker.url, 'harness-token')
  const session = 'lane'
  const token = await api.token(session)
  const hand = Lib.startHand({
    dir: work,
    name: 'h1',
    out,
    token,
    url: worker.url + '/sessions/' + session + '/hands',
  })
  const result = { lane: lane.name, shape: shapeName, kills: [], anomalies, failures: [] }
  let stopped = false
  const read = (file) => {
    try {
      return Fs.readFileSync(Path.join(work, file), 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  try {
    for (let tries = 0; !(await api.hands(session)).includes('h1'); tries++) {
      if (tries > 150) throw new Error('the hand did not attach')
      await Lib.sleep(100)
    }

    const waiters = []
    endpoint.state.hook = (kind, entry) => {
      for (const waiter of waiters) {
        if (waiter.fired || waiter.kind !== kind || waiter.label !== entry.decision) continue
        if (
          waiter.nth !== undefined &&
          endpoint.requests.filter((request) => request.decision === entry.decision).length !==
            waiter.nth
        )
          continue
        waiter.fired = true
        waiter.resolve(entry)
        if (waiter.hold) return 'hold'
      }
      return undefined
    }
    const trigger = (spec) => {
      if (spec.on === 'mark')
        return (async () => {
          const wanted = [].concat(spec.mark)
          while (!wanted.every((mark) => read(spec.file ?? 'steps.log').includes(mark)))
            await Lib.sleep(10)
        })()
      if (spec.on === 'request' || spec.on === 'answered')
        return new Promise((resolve) =>
          waiters.push({
            hold: spec.hold,
            kind: spec.on,
            label: spec.label,
            nth: spec.nth,
            resolve,
          }),
        )
      if (spec.on === 'back') return Promise.resolve()
      throw new Error('unknown trigger ' + JSON.stringify(spec))
    }
    const armed = (lane.kills ?? []).map((spec) => (spec.on === 'back' ? undefined : trigger(spec)))

    const submitted = await api.submit(session, {
      hand: 'h1',
      model: shape.model,
      prompt: 'Run the scripted steps.',
      provider: shape.provider,
      request_id: 'turn-1',
    })
    if (submitted.status !== 202 && submitted.status !== 200)
      throw new Error(
        'submitting answered ' + submitted.status + ' ' + JSON.stringify(submitted.body),
      )
    const submittedAt = Date.now()

    const killing = (async () => {
      for (const [index, spec] of (lane.kills ?? []).entries()) {
        await (armed[index] ?? trigger(spec))
        if (spec.delayMs) await Lib.sleep(spec.delayMs)
        const at = Date.now()
        const asked = endpoint.requests.length
        await Lib.stopWorker(worker, spec.signal ?? 'SIGKILL')
        const stored = Lib.storage(out).find((entry) => entry.tables?.nanocode_log !== undefined)
        if (spec.restartAfter) {
          const wanted = [].concat(spec.restartAfter)
          while (!wanted.every((mark) => read('ends.log').includes(mark))) await Lib.sleep(20)
        }
        if (stopped) return
        const down = Date.now()
        worker = await Lib.startWorker({ out, port, vars })
        result.kills.push({
          afterSubmitMs: at - submittedAt,
          askedBefore: asked,
          backMs: Date.now() - down,
          downMs: Date.now() - at,
          handRequests: stored?.hand_requests?.map(
            (row) => row[1] + (row[2] ? ':replied' : ':pending'),
          ),
          logRows: stored?.tables?.nanocode_log,
          stepsAtKill: read('steps.log').join(' '),
          endsAtKill: read('ends.log').join(' '),
        })
      }
    })()

    let report
    const deadline = Date.now() + (lane.timeoutMs ?? 120_000)
    for (;;) {
      report = await api.turn(session, 'turn-1').catch((error) => ({ status: String(error) }))
      if (
        report.status === 'completed' ||
        report.status === 'failed' ||
        report.status === 'cancelled'
      )
        break
      if (Date.now() > deadline) break
      await Lib.sleep(200)
    }
    stopped = true
    await Promise.race([killing, Lib.sleep(1000)])
    result.status = report.status
    result.message = report.ok?.message ?? report.error
    result.turnMs = Date.now() - submittedAt

    const requests = endpoint.requests
    const answered = requests.filter((entry) => entry.answeredAt !== null)
    result.asked = requests.map((entry) => entry.decision)
    result.requests = requests.length
    result.answered = answered.length
    result.transports = [...new Set(requests.map((entry) => entry.transport))]
    const steps = read('steps.log')
    result.steps = steps.join(' ')
    const counts = new Map()
    for (const step of steps) counts.set(step, (counts.get(step) ?? 0) + 1)
    result.ranTwice = [...counts].filter(([, count]) => count > 1).map(([step]) => step)
    const expectedMarks = [...lane.rounds, ...(lane.child ?? [])]
      .flat()
      .flatMap((action) => (action.exec ? [action.exec] : []))
    result.missing = expectedMarks.filter((mark) => !counts.has(mark))
    result.unknownOutputs = requests
      .flatMap((entry) => entry.outputs.filter((output) => unknown.test(output ?? '')))
      .filter((output, index, all) => all.indexOf(output) === index)

    const usage = endpoint.usage(shape.provider)
    const reported = report.ok?.usage ?? {}
    result.usage = {
      answered: { input: answered.length * usage.input, output: answered.length * usage.output },
      report: { input: reported.input_tokens, output: reported.output_tokens },
    }

    let events = []
    let published = []
    try {
      events = await api.events(session)
      published = await api.published(session)
    } catch (error) {
      result.failures.push('reading events: ' + String(error))
    }
    Fs.writeFileSync(Path.join(out, 'events.json'), JSON.stringify(events, null, 1))
    Fs.writeFileSync(Path.join(out, 'published.json'), JSON.stringify(published, null, 1))
    const inner = published.map((entry) => {
      const outer = entry.event.event ?? {}
      if (outer.source === 'subagent') {
        const update = outer.update ?? {}
        return update.type === 'event'
          ? {
              agent: update.id,
              payload: update.event?.payload ?? {},
              seq: entry.event.seq,
              type: update.event?.type,
            }
          : {
              agent: update.id ?? update.agent?.id,
              payload: update,
              seq: entry.event.seq,
              type: 'subagent.' + update.type,
            }
      }
      return {
        agent: 0,
        payload: outer.event?.payload ?? outer,
        seq: entry.event.seq,
        type: outer.event?.type ?? outer.type,
      }
    })
    const tokens = (list, key) =>
      list.reduce((sum, event) => sum + (event.payload?.usage?.[key] ?? 0), 0)
    const counted = (list) => ({
      calls: list.length,
      input: tokens(list, 'input_tokens'),
      output: tokens(list, 'output_tokens'),
    })
    const calls = inner.filter((event) => event.type === 'model.call.completed')
    const fresh = calls.filter((event) => event.payload?.timing?.replayed !== true)
    result.usage.eventsAll = counted(calls)
    result.usage.eventsNotReplayed = counted(fresh)
    result.usage.mainNotReplayed = counted(fresh.filter((event) => event.agent === 0))
    result.usage.childNotReplayed = counted(fresh.filter((event) => event.agent !== 0))
    const tally = (type, key) => {
      const seen = new Map()
      for (const event of inner)
        if (event.type === type && event.seq !== 0)
          seen.set(key(event), (seen.get(key(event)) ?? 0) + 1)
      return seen
    }
    const twice = (seen) =>
      [...seen].filter(([, count]) => count > 1).map(([key, count]) => key + ' x' + count)
    const types = {}
    for (const event of inner) {
      const name = (event.agent === 0 ? '' : 'sub:') + event.type
      types[name] = (types[name] ?? 0) + 1
    }
    result.events = {
      logged: events.length,
      published: published.length,
      live: inner.filter((event) => event.seq === 0).length,
      types,
      toolCallsTwice: twice(
        tally('tool.call', (event) => event.agent + ':' + event.payload.call_id),
      ),
      toolResultsTwice: twice(
        tally('tool.result', (event) => event.agent + ':' + event.payload.call_id),
      ),
      outcomeUnknown: published.filter((entry) =>
        JSON.stringify(entry).includes('"outcome_unknown":true'),
      ).length,
      scopes: [...new Set(published.map((entry) => entry.scope))],
    }
    result.rows = (await api.metrics(session).catch(() => ({})))?.log
    const expected = lane.expect
    const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
    const alternatives = Array.isArray(expected[0]) ? expected : [expected]
    const sub = (list, wanted) => list.filter((entry) => entry.startsWith('sub:') === wanted)
    result.matched = alternatives.findIndex((alternative) =>
      lane.child
        ? same(sub(result.asked, false), sub(alternative, false)) &&
          same(sub(result.asked, true), sub(alternative, true))
        : same(result.asked, alternative),
    )
    if (result.matched < 0)
      result.failures.push(
        'asked ' + JSON.stringify(result.asked) + ' but expected ' + JSON.stringify(expected),
      )
    const byLabel = new Map()
    for (const entry of requests)
      byLabel.set(entry.decision, [...(byLabel.get(entry.decision) ?? []), entry])
    for (const [decision, entries] of byLabel)
      if (new Set(entries.map((entry) => entry.digest)).size !== 1)
        result.failures.push(
          'the request ' + decision + ' was repeated with a different conversation',
        )
    result.repeats = [...byLabel]
      .filter(([, entries]) => entries.length > 1)
      .map(
        ([decision, entries]) =>
          decision +
          ' x' +
          entries.length +
          (new Set(entries.map((entry) => entry.raw)).size === 1
            ? ' (identical)'
            : ' (not byte-identical)'),
      )
    if (result.status !== 'completed')
      result.failures.push(
        'the turn ended ' + result.status + ': ' + JSON.stringify(result.message),
      )
    else if (result.message !== 'The task is complete.')
      result.failures.push('the final message was ' + JSON.stringify(result.message))
    if (result.ranTwice.length) result.failures.push('ran twice: ' + result.ranTwice.join(' '))
    if (result.missing.length) result.failures.push('never ran: ' + result.missing.join(' '))
    if (result.unknownOutputs.length || result.events.outcomeUnknown)
      result.failures.push(
        'a tool call ended with an unknown outcome: ' +
          JSON.stringify(result.unknownOutputs).slice(0, 300),
      )
    if (anomalies.length) result.failures.push(...anomalies)
    if ((lane.kills ?? []).length !== result.kills.length)
      result.failures.push(
        'only ' + result.kills.length + ' of ' + lane.kills.length + ' kills happened',
      )
    const lost = (wanted) =>
      [...byLabel]
        .filter(([decision]) => decision.startsWith('sub:') === wanted)
        .reduce(
          (sum, [, entries]) =>
            sum + entries.slice(0, -1).filter((entry) => entry.answeredAt !== null).length,
          0,
        )
    const keptOf = (wanted) =>
      answered.filter((entry) => entry.decision.startsWith('sub:') === wanted).length - lost(wanted)
    result.lostAnswers = lost(false) + lost(true)
    const kept = keptOf(false)
    const keptChild = keptOf(true)
    result.usage.kept = { calls: kept, input: kept * usage.input, output: kept * usage.output }
    result.usage.keptChild = {
      calls: keptChild,
      input: keptChild * usage.input,
      output: keptChild * usage.output,
    }
    if (
      result.usage.report.input !== result.usage.kept.input ||
      result.usage.report.output !== result.usage.kept.output
    )
      result.failures.push(
        'the turn reports ' +
          JSON.stringify(result.usage.report) +
          ' tokens for ' +
          JSON.stringify(result.usage.kept) +
          ' of the responses it kept (' +
          answered.length +
          ' answered, ' +
          result.lostAnswers +
          ' lost with the Worker)',
      )
    if (
      result.usage.mainNotReplayed.calls !== kept ||
      result.usage.mainNotReplayed.input !== result.usage.kept.input
    )
      result.failures.push(
        'the events carry ' +
          JSON.stringify(result.usage.mainNotReplayed) +
          ' model calls that are not replays for ' +
          JSON.stringify(result.usage.kept) +
          ' kept',
      )
    if (
      result.usage.childNotReplayed.calls !== keptChild ||
      result.usage.childNotReplayed.input !== result.usage.keptChild.input
    )
      result.failures.push(
        'the subagent events carry ' +
          JSON.stringify(result.usage.childNotReplayed) +
          ' model calls that are not replays for ' +
          JSON.stringify(result.usage.keptChild) +
          ' kept',
      )
    result.stream = []
    if (result.lostAnswers)
      result.stream.push(
        result.lostAnswers + ' answered response(s) died with the Worker and are in no usage count',
      )
    if (result.events.toolCallsTwice.length)
      result.stream.push('tool.call published twice: ' + result.events.toolCallsTwice.join(', '))
    if (result.events.toolResultsTwice.length)
      result.stream.push(
        'tool.result published twice: ' + result.events.toolResultsTwice.join(', '),
      )
    if (result.usage.eventsAll.calls !== answered.length)
      result.stream.push(
        'model.call.completed x' +
          result.usage.eventsAll.calls +
          ' for ' +
          answered.length +
          ' answered (' +
          (result.usage.eventsAll.calls - result.usage.eventsNotReplayed.calls) +
          ' flagged replayed)',
      )
    for (const type of [
      'input.accepted',
      'run.started',
      'running',
      'sub:input.accepted',
      'sub:run.started',
      'sub:subagent.added',
      'sub:subagent.completion',
    ])
      if ((result.events.types[type] ?? 0) > 1)
        result.stream.push(type + ' x' + result.events.types[type])
  } catch (error) {
    result.failures.push('harness: ' + String(error?.stack ?? error))
  } finally {
    stopped = true
    await Lib.stopWorker(worker).catch(() => {})
    Lib.stopHand(hand)
    endpoint.close()
  }
  result.passed = result.failures.length === 0
  result.wallMs = Date.now() - started
  Fs.writeFileSync(Path.join(out, 'requests.json'), JSON.stringify(endpoint.requests, null, 1))
  Fs.writeFileSync(Path.join(out, 'result.json'), JSON.stringify(result, null, 1))
  return result
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const [name, shapeName = 'claude', runs = '1', port = '8811', tag = 'dev'] = process.argv.slice(2)
  const lane = lanes[name]
  if (!lane || !shapes[shapeName]) {
    console.error(
      'usage: node bench/resume/run.ts <lane> <shape> [runs] [port] [tag]\nlanes: ' +
        Object.keys(lanes).join(' ') +
        '\nshapes: ' +
        Object.keys(shapes).join(' '),
    )
    process.exit(2)
  }
  let failed = 0
  for (let index = 1; index <= Number(runs); index++) {
    const out = Path.join(Lib.output, tag, name + '.' + shapeName, String(index))
    const result = await run({ ...lane, name }, shapeName, { out, port: Number(port) })
    if (!result.passed) failed++
    console.log(
      JSON.stringify({
        lane: name,
        shape: shapeName,
        run: index,
        passed: result.passed,
        requests: result.requests,
        answered: result.answered,
        asked: result.asked,
        matched: result.matched,
        repeats: result.repeats,
        kills: result.kills.map((kill) => ({
          rows: kill.logRows,
          asked: kill.askedBefore,
          backMs: kill.backMs,
          hand: kill.handRequests?.length,
        })),
        usage: result.usage,
        stream: result.stream,
        transports: result.transports,
        wallMs: result.wallMs,
        failures: result.failures,
      }),
    )
  }
  process.exit(failed ? 1 : 0)
}
