export const shapes = {
  claude: { model: 'claude-opus-5-5', provider: 'claude', websocket: false },
  'luna-http': { model: 'gpt-6-luna', provider: 'codex', websocket: false },
  'luna-ws': { model: 'gpt-6-luna', provider: 'codex', websocket: true },
  'right-http': { model: 'gpt-right', provider: 'codex', websocket: false },
  'right-ws': { model: 'gpt-right', provider: 'codex', websocket: true },
}

const long = 16

const six = (sleep, wait = true) => [
  [{ exec: 's1' }],
  [{ exec: 's2' }],
  [{ exec: 's3' }],
  [{ exec: 's4', sleep }],
  ...(wait ? [[{ wait: 's4' }]] : []),
  [{ exec: 's5' }],
  [{ exec: 's6' }],
]
const sixAsked = [
  'exec s1',
  'exec s2',
  'exec s3',
  'exec s4',
  'wait s4',
  'exec s5',
  'exec s6',
  'final',
]
const repeated = (asked, label, times = 2) =>
  asked.flatMap((entry) => (entry === label ? Array(times).fill(entry) : [entry]))

const pair = [
  [{ exec: 's1' }],
  [
    { exec: 's2a', sleep: long },
    { exec: 's2b', sleep: long },
  ],
  [{ wait: 's2a' }, { wait: 's2b' }],
  [{ exec: 's3' }],
]
const pairAsked = ['exec s1', 'exec s2a+exec s2b', 'wait s2a+wait s2b', 'exec s3', 'final']

const after = (delayMs) => ({
  expect: [sixAsked, repeated(sixAsked, 'exec s3'), repeated(sixAsked, 'exec s4')],
  kills: [{ delayMs, label: 'exec s3', on: 'answered' }],
  rounds: six(long),
})

const spawn = {
  code: 'spawn',
  source: () =>
    'const agent = await tools.spawn_agent({ harness: null, model: null, output_contract: { kind: "string" }, reasoning_mode: null, role: "worker", task: "SUBAGENT-TASK: run the scripted child steps.", thinking: null }); text(JSON.stringify(agent))',
}
const join = {
  code: 'join',
  source: (view) => {
    const id = /"agent_id":(\d+)/.exec(view.calls[0]?.output ?? '')?.[1]
    return (
      '// @exec: {"yield_time_ms": 120000}\nconst waited = await tools.wait_agent({ agent_ids: [' +
      id +
      '], timeout_ms: 100000 }); text(JSON.stringify(waited.agents.map((agent) => agent.status.state)))'
    )
  },
}
const submit = {
  code: 'submit',
  source: () =>
    'const receipt = await tools.submit_result({ output: "child done" }); text(JSON.stringify(receipt))',
}
const family = (sleep) => ({
  child: [[{ exec: 'c1' }], [{ exec: 'c2', sleep }], [{ wait: 'c2' }], [submit]],
  expect: [
    'code spawn',
    'code join',
    'exec p3',
    'final',
    'sub:exec c1',
    'sub:exec c2',
    'sub:wait c2',
    'sub:code submit',
    'sub:final',
  ],
  rounds: [[spawn], [join], [{ exec: 'p3' }]],
})

export const lanes = {
  clean: { expect: sixAsked, rounds: six(5) },
  subClean: family(5),
  subCell: { ...family(long), kills: [{ delayMs: 1500, mark: 'c2', on: 'mark' }] },
  subWait: { ...family(long), kills: [{ delayMs: 2000, label: 'sub:wait c2', on: 'answered' }] },
  subModel: {
    ...family(long),
    expect: family(long).expect.flatMap((entry) =>
      entry === 'sub:exec c2' ? [entry, entry] : [entry],
    ),
    kills: [{ delayMs: 1000, hold: true, label: 'sub:exec c2', on: 'request' }],
  },

  cell: { expect: sixAsked, kills: [{ delayMs: 1500, mark: 's4', on: 'mark' }], rounds: six(long) },
  model: {
    expect: repeated(sixAsked, 'exec s3'),
    kills: [{ delayMs: 1000, hold: true, label: 'exec s3', on: 'request' }],
    rounds: six(long),
  },
  wait: {
    expect: sixAsked,
    kills: [{ delayMs: 2000, label: 'wait s4', on: 'answered' }],
    rounds: six(long),
  },

  pair: {
    expect: pairAsked,
    kills: [{ delayMs: 1500, mark: ['s2a', 's2b'], on: 'mark' }],
    rounds: pair,
  },
  pairDone: {
    expect: ['exec s1', 'exec s2a+exec s2b', 'wait s2b', 'exec s3', 'final'],
    kills: [{ delayMs: 1500, mark: ['s2a', 's2b'], on: 'mark' }],
    rounds: [
      [{ exec: 's1' }],
      [{ exec: 's2a' }, { exec: 's2b', sleep: long }],
      [{ wait: 's2b' }],
      [{ exec: 's3' }],
    ],
  },
  pairWaits: {
    expect: pairAsked,
    kills: [{ delayMs: 2000, label: 'wait s2a+wait s2b', on: 'answered' }],
    rounds: pair,
  },
  waitExec: {
    expect: ['exec s1', 'exec s2', 'wait s2+exec s3', 'wait s3', 'exec s4', 'final'],
    kills: [{ delayMs: 1500, mark: 's3', on: 'mark' }],
    rounds: [
      [{ exec: 's1' }],
      [{ exec: 's2', sleep: long }],
      [{ wait: 's2' }, { exec: 's3', sleep: long }],
      [{ wait: 's3' }],
      [{ exec: 's4' }],
    ],
  },

  after0: after(0),
  after3: after(3),
  after10: after(10),
  after30: after(30),
  cellDown: {
    expect: sixAsked.filter((entry) => entry !== 'wait s4'),
    kills: [{ delayMs: 500, mark: 's4', on: 'mark', restartAfter: 's4' }],
    rounds: six(2, false),
  },
  waitDown: {
    expect: sixAsked,
    kills: [{ delayMs: 1000, label: 'wait s4', on: 'answered', restartAfter: 's4' }],
    rounds: six(8),
  },
  twoKills: {
    expect: sixAsked,
    kills: [
      { delayMs: 1500, mark: 's4', on: 'mark' },
      { delayMs: 2000, label: 'wait s4', on: 'answered' },
    ],
    rounds: six(30),
  },
  twoRecovery: {
    expect: sixAsked,
    kills: [
      { delayMs: 1500, mark: 's4', on: 'mark' },
      { delayMs: 1500, on: 'back' },
    ],
    rounds: six(30),
  },
  twoModel: {
    expect: repeated(sixAsked, 'exec s3', 3),
    kills: [
      { delayMs: 1000, hold: true, label: 'exec s3', nth: 1, on: 'request' },
      { delayMs: 1000, hold: true, label: 'exec s3', nth: 2, on: 'request' },
    ],
    rounds: six(long),
  },
}
