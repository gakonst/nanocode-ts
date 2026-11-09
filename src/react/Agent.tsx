'use client'

import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import * as Config from '../client/Config.ts'
import type * as Contracts from '../Contracts.ts'
import type * as LiveEvent from '../client/LiveEvent.ts'
import * as Pickers from '../client/Pickers.ts'
import * as Plans from '../client/Plans.ts'
import type * as Relay from '../client/Relay.ts'
import type * as ClientTransport from '../client/Transport.ts'
import { Keyring, Wallet } from '../machines/index.ts'
import { ChatGpt } from './clones/ChatGpt.tsx'
import { Claude } from './clones/Claude.tsx'
import type { CloneMenuItem } from './clones/Shared.tsx'
import {
  Chat,
  HandConnect,
  NanocodeProvider,
  type Picker,
  PlanConnect,
  useConfig,
  useConversations,
  useHand,
  usePlans,
  useSend,
} from './index.tsx'
import { Prompts, Unlock, useUnlock, walletCards } from './Machines.tsx'
import { skin, styles } from './Skin.ts'

export type Theme = 'claude' | 'codex' | 'nanocode'

export type Model = Pickers.Model & { detail?: string; label: string }

export type Harness = Omit<Pickers.Harness, 'models'> & { models: Model[] }

export type Selection = {
  harness: Harness['id']
  model: string
  payer: Contracts.Payer
  thinking: string
}

export type Context = {
  headers(): Record<string, string>
  selection(): Selection
  session: { load(): { id?: string }; save(session: { id?: string }): void }
}

export type Host = {
  keyring: Keyring.Keyring
  plans?: Plans.Client
  transport: ClientTransport.Transport &
    Relay.Source & { crash?(): Promise<Response>; session(): { id?: string }; warm(): void }
}

type Saved = {
  bound: Record<string, string>
  paid?: Record<string, Contracts.Payer>
  payer?: Contracts.Payer
  picked?: string
  thinking?: Record<string, string>
}

type Instance = ReturnType<typeof create>

const commands = [
  { detail: 'choose harness, model and thinking for a new session', label: '/model' },
  { detail: 'choose the thinking of the next turns', label: '/effort' },
  {
    detail: 'choose who pays for the model: this deployment, Tempo Wallet or your plan',
    label: '/pay',
  },
  { detail: 'start a new session', label: '/new' },
  { detail: "run this session's code on your machine", label: '/hand' },
]

const highlight = () => import('../Highlight.ts').then((module) => module.highlight)

export function Agent(props: Agent.Props) {
  const [agent] = useState(() => create(props))
  return (
    <NanocodeProvider config={agent.config} highlight={highlight} skin={skin}>
      <View {...props} agent={agent} />
    </NanocodeProvider>
  )
}

export declare namespace Agent {
  type Props = {
    apply?(event: LiveEvent.LiveEvent, note: Config.Config['note']): void
    connect(context: Context): Host
    crash?: string
    effortCommand?: boolean
    footer?: ReactNode
    harnesses: Harness[]
    model?: string
    planHarnesses?: Harness[]
    prompts?: readonly string[]
    scripts?: boolean
    storage: string
    theme: Theme
    title?: string
    token?: boolean | (() => Promise<boolean>)
    wallet: Wallet.Options
    walletHarnesses?: Harness[]
  }
}

function create(props: Agent.Props) {
  const history =
    props.theme === 'nanocode'
      ? props.storage
      : `${props.storage}:${props.theme === 'codex' ? 'chatgpt' : 'claude'}`
  const key = `${history}:models`
  const token = `${props.storage}:token`
  const shown = (harnesses: Harness[] | undefined) =>
    !harnesses
      ? []
      : props.theme === 'nanocode'
        ? harnesses
        : harnesses.filter((harness) => harness.id === props.theme)
  const listeners = new Set<() => void>()
  const saved: Saved = { bound: {}, ...JSON.parse(localStorage.getItem(key) ?? '{}') }
  let status: Plans.Status | undefined
  let version = 0

  const changed = () => {
    version++
    for (const listener of listeners) listener()
  }

  const persist = () => {
    const ids = new Set(config.getState().conversations.map((item) => item.id))
    saved.bound = Object.fromEntries(Object.entries(saved.bound).filter(([id]) => ids.has(id)))
    saved.paid = Object.fromEntries(Object.entries(saved.paid ?? {}).filter(([id]) => ids.has(id)))
    localStorage.setItem(key, JSON.stringify(saved))
    changed()
  }

  const signed = (provider: Plans.Provider) => status?.[provider].state === 'authenticated'

  const harnessesOf = (payer: Contracts.Payer) =>
    payer === 'wallet'
      ? shown(props.walletHarnesses)
      : payer === 'plan'
        ? shown(props.planHarnesses).filter((harness) => signed(harness.id))
        : shown(props.harnesses)

  const payer = (): Contracts.Payer => {
    const conversation = config.getState().conversation
    const bound = conversation ? saved.paid?.[conversation] : undefined
    if (bound) return bound
    const chosen = saved.payer ?? 'deployment'
    return harnessesOf(chosen).length ? chosen : 'deployment'
  }

  const offered = () => {
    const harnesses = harnessesOf(payer())
    return harnesses.length ? harnesses : shown(props.harnesses)
  }

  const models = () => offered().flatMap((harness) => harness.models)

  const current = (): Model => {
    const conversation = config.getState().conversation
    const id = (conversation && saved.bound[conversation]) || saved.picked || props.model
    return models().find((model) => model.id === id) ?? models()[0]!
  }

  const harnessOf = (model: Model) => offered().find((harness) => harness.models.includes(model))!

  const thinking = (model: Model) =>
    saved.thinking?.[model.id] ?? (model.efforts.includes('low') ? 'low' : model.effort)

  const headers = (): Record<string, string> => {
    const secret = localStorage.getItem(token)
    return { ...Keyring.visitorHeaders(), ...(secret ? { authorization: `Bearer ${secret}` } : {}) }
  }

  Wallet.configure(props.wallet)

  const host = props.connect({
    headers,
    selection: () => {
      const model = current()
      return {
        harness: harnessOf(model).id,
        model: model.id,
        payer: payer(),
        thinking: thinking(model),
      }
    },
    session: {
      load: () => ({}),
      save: (session) => {
        const conversation = config.getState().conversation
        if (!session.id || !conversation || saved.bound[conversation]) return changed()
        saved.bound[conversation] = current().id
        saved.paid = { ...saved.paid, [conversation]: payer() }
        persist()
      },
    },
  })

  const config = Config.create({
    history: { key: history },
    transport: host.transport,
    ...(props.apply
      ? { apply: (event: LiveEvent.LiveEvent) => props.apply!(event, config.note) }
      : {}),
  })

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    const off = config.subscribe(listener)
    return () => {
      listeners.delete(listener)
      off()
    }
  }

  return {
    bound: () => {
      const conversation = config.getState().conversation
      return Boolean(conversation && saved.bound[conversation])
    },
    choose: (id: string) => {
      const conversation = config.getState().conversation
      saved.picked = id
      if (conversation && saved.bound[conversation] && saved.bound[conversation] !== id)
        config.create()
      persist()
    },
    config,
    current,
    harnessOf,
    host,
    models,
    offer: (next: Plans.Status | undefined) => {
      status = next
    },
    offered,
    pay: (next: Contracts.Payer, model?: string) => {
      const conversation = config.getState().conversation
      const moved = payer() !== next
      saved.payer = next
      if (model) saved.picked = model
      if (moved && conversation && saved.bound[conversation]) config.create()
      persist()
    },
    payer,
    prefer: (next: Contracts.Payer) => {
      saved.payer = next
      persist()
    },
    planned: (provider: Plans.Provider) =>
      shown(props.planHarnesses).find((harness) => harness.id === provider),
    signed,
    walletHarnesses: () => shown(props.walletHarnesses),
    think: (id: string, level: string) => {
      saved.picked = id
      saved.thinking = { ...saved.thinking, [id]: level }
      persist()
    },
    thinking,
    token,
    use: () =>
      useSyncExternalStore(
        subscribe,
        () => `${version}:${config.getState().conversation}`,
        () => '',
      ),
  }
}

function View(props: Agent.Props & { agent: Instance }) {
  const { agent } = props
  const { transport } = agent.host
  agent.use()
  const config = useConfig()
  const { send, isPending: busy } = useSend()
  const { current: conversation } = useConversations()
  const [picker, setPicker] = useState<Picker | null>(null)
  const [asks, setAsks] = useState(props.token === true)
  const [secret, setSecret] = useState(() => localStorage.getItem(agent.token) ?? '')
  const unlock = useUnlock(agent.host.keyring, { scripts: props.scripts ?? false })
  const hand = useHand(transport)
  const plans = usePlans(agent.host.plans)
  agent.offer(plans.status)
  const session = transport.session().id
  const opened = useRef(session)
  const joined = useRef(plans.status)

  useEffect(() => {
    if (typeof props.token === 'function') void props.token().then(setAsks)
  }, [])

  useEffect(() => {
    const events = ['keydown', 'pointerdown', 'pointermove', 'touchstart'] as const
    const stop = () => {
      for (const event of events) window.removeEventListener(event, warm)
    }
    function warm() {
      stop()
      transport.warm()
    }
    for (const event of events) window.addEventListener(event, warm, { passive: true })
    return stop
  }, [])

  useEffect(() => {
    if (opened.current && opened.current !== session) hand.reset()
    opened.current = session
  }, [session])

  useEffect(() => {
    if (props.theme === 'nanocode') void config.resume()
  }, [conversation])

  useEffect(() => {
    const was = joined.current
    joined.current = plans.status
    const provider = (['claude', 'codex'] as const).find(
      (entry) =>
        was &&
        was[entry].state !== 'authenticated' &&
        plans.status?.[entry].state === 'authenticated',
    )
    if (!provider || !agent.planned(provider)) return
    agent.prefer('plan')
    config.note(
      'tool',
      `Your ${Plans.name(provider)} plan pays for the model in new sessions; type /pay to choose another payer.`,
    )
  }, [plans.status])

  const model = agent.current()
  const harness = agent.harnessOf(model)
  const level = agent.thinking(model)
  const payer = agent.payer()
  const signed = (provider: Plans.Provider) => plans.status?.[provider].state === 'authenticated'
  const paidBy = (entry: Contracts.Payer, provider: Plans.Provider = harness.id) =>
    entry === 'wallet'
      ? 'Tempo Wallet'
      : entry === 'plan'
        ? `${Plans.name(provider)} plan`
        : 'this deployment'

  const ready = async () => {
    if (agent.payer() !== 'wallet') return
    const key = unlock.connected ?? Wallet.restore()
    if (!key)
      return config.note(
        'error',
        'Tempo Wallet pays for this session: connect it with /login, or type /new and /pay to choose another payer.',
      )
    await agent.host.keyring
      .register(key)
      .catch((error: unknown) =>
        config.note('error', error instanceof Error ? error.message : String(error)),
      )
  }

  const submit = (text: string) => void ready().then(() => send(text))

  const payerItems = (): Pickers.Item[] => [
    {
      kind: 'choice',
      label: 'this deployment',
      value: 'deployment',
      detail: `the free models on the key of ${props.wallet.name}`,
      current: payer === 'deployment',
    },
    ...(agent.walletHarnesses().length
      ? [
          {
            kind: 'choice' as const,
            label: 'Tempo Wallet',
            value: 'wallet',
            detail: unlock.connected
              ? `MACH per token from ${Wallet.short(unlock.connected.address)}`
              : 'MACH per token from your wallet, after you connect it',
            current: payer === 'wallet',
          },
        ]
      : []),
    ...(agent.host.plans
      ? (['claude', 'codex'] as const)
          .filter((provider) => agent.planned(provider))
          .map((provider) => ({
            kind: 'choice' as const,
            label: `${Plans.name(provider)} plan`,
            value: `plan:${provider}`,
            detail: signed(provider) ? 'your subscription' : 'your subscription, after you sign in',
            current: payer === 'plan' && harness.id === provider,
          }))
      : []),
  ]

  const choosePayer = async (value: string) => {
    setPicker(null)
    const [next, provider] = value.split(':') as [Contracts.Payer, Plans.Provider | undefined]
    if (next === 'plan' && provider && !signed(provider)) return plans.signIn(provider)
    if (next === 'wallet' && !unlock.connected) {
      await unlock.command('/login', false)
      if (!Wallet.restore()) return
    }
    const first =
      next === 'plan' && provider && provider !== harness.id
        ? agent.planned(provider)?.models[0]?.id
        : undefined
    const moved = next !== payer && agent.bound()
    agent.pay(next, first)
    config.note(
      'tool',
      `${paidBy(next, provider)} pays for the model${moved ? ' in a new session' : ''}`,
    )
  }

  const openPayers = () =>
    setPicker({
      items: payerItems,
      onChoose: (item) => void choosePayer(item.value ?? item.label),
      title: 'Who pays for the model',
    })

  const think = (id: string, chosen: string) => {
    if (session && props.effortCommand) {
      if (chosen !== level) void send(`/effort ${chosen}`)
      return agent.think(id, chosen)
    }
    agent.think(id, chosen)
    config.note('tool', `using ${id} · thinking ${chosen}`)
  }

  const pickThinking = (id: string) =>
    setPicker({
      items: () =>
        Pickers.thinking(
          agent.models().find((entry) => entry.id === id),
          id === model.id ? { thinking: level } : {},
        ),
      onChoose: (item) => {
        setPicker(null)
        think(id, item.label)
      },
      title: `Thinking · ${id}`,
    })

  const pick = (id: string) => {
    if (session && id !== model.id) {
      setPicker(null)
      return config.note(
        'tool',
        'the model is fixed for this session; use /new before choosing another model',
      )
    }
    pickThinking(id)
  }

  const reset = () => {
    config.clear()
    hand.reset()
  }

  const command = (text: string): boolean => {
    const [name, ...words] = text.split(/\s+/)
    const argument = words.join(' ').toLowerCase()
    if (name === '/new') {
      reset()
      config.note('tool', 'new session')
      return true
    }
    if (name === '/hand') {
      hand.show()
      return true
    }
    if (name === '/pay') {
      if (!argument) {
        openPayers()
        return true
      }
      const match = payerItems().find(
        (item) => item.value === argument || item.label.toLowerCase().includes(argument),
      )
      if (match) void choosePayer(match.value ?? match.label)
      else
        config.note(
          'error',
          `no payer matches "${argument}"; choose one of ${payerItems()
            .map((item) => item.label)
            .join(', ')}`,
        )
      return true
    }
    if (name === '/model') {
      if (!argument) {
        setPicker({
          filter: true,
          items: (query) => Pickers.models(agent.offered(), { model: model.id, query }),
          onChoose: (item) => pick(item.label),
          title: 'Model',
        })
        return true
      }
      const match = agent
        .models()
        .find((entry) =>
          argument
            .split(' ')
            .every((word) => `${entry.id} ${entry.name}`.toLowerCase().includes(word)),
        )
      if (match) pick(match.id)
      else
        config.note(
          'error',
          `no model matches "${argument}"; choose one of ${agent
            .models()
            .map((entry) => entry.id)
            .join(', ')}`,
        )
      return true
    }
    if (name !== '/effort') return false
    if (!argument) {
      pickThinking(model.id)
      return true
    }
    if (model.efforts.includes(argument as Model['effort'])) think(model.id, argument)
    else
      config.note('error', `${model.id} takes ${model.efforts.join('/')} thinking, not ${argument}`)
    return true
  }

  const crash = async () => {
    if (!session) return config.note('error', 'Start a session before arming a crash.')
    const response = await transport.crash!()
    if (response.ok) config.note('tool', props.crash!)
    else config.note('error', `${response.status} ${await response.text()}`)
  }

  const remember = (value: string) => {
    setSecret(value)
    localStorage.setItem(agent.token, value)
  }

  if (props.theme === 'nanocode')
    return (
      <Chat
        actions={
          <>
            <button
              disabled={busy}
              onClick={openPayers}
              type="button"
              {...styles.suggestion({ quiet: true })}
            >
              Paid by {paidBy(payer)}
            </button>
            <button
              disabled={busy}
              onClick={reset}
              type="button"
              {...styles.suggestion({ quiet: true })}
            >
              New session
            </button>
          </>
        }
        after={walletCards(unlock)}
        commands={[...commands, ...unlock.commands]}
        empty="Ask a question to start a turn, or type /model to choose a model."
        extras={
          <>
            {agent.host.plans && <PlanConnect plans={plans} />}
            <HandConnect hand={hand} />
            <Unlock machine={unlock} />
            <Prompts machine={unlock} />
            {asks && (
              <label {...styles.row()}>
                <span aria-hidden="true" {...styles.chevron()}>
                  #
                </span>
                <input
                  aria-label="Access token"
                  onChange={(event) => remember(event.target.value)}
                  placeholder="Access token"
                  type="password"
                  value={secret}
                  {...styles.input()}
                />
              </label>
            )}
          </>
        }
        link={{ href: 'https://nanocode.xyz/', label: 'nanocode.xyz →' }}
        onInput={(text) => {
          if (!busy && text && !text.startsWith('/')) transport.warm()
        }}
        onPickerClose={() => setPicker(null)}
        onSubmit={(text) => {
          if (unlock.handles(text)) void unlock.command(text)
          else if (!command(text)) submit(text)
        }}
        picker={picker}
        status={`${harness.label} · ${model.label} · ${level} · paid by ${paidBy(payer)} · ${session ?? 'new session'}${hand.where ? ` · ${hand.where}` : ''} · ${busy ? 'running' : 'idle'}`}
        suggestions={[
          ...(props.prompts ?? []).map((prompt) => ({
            disabled: busy,
            label: prompt,
            onClick: () => submit(prompt),
          })),
          ...(props.crash && transport.crash
            ? [
                {
                  disabled: !session,
                  label: 'Kill the next tool call',
                  onClick: () => void crash(),
                },
              ]
            : []),
        ]}
      />
    )

  const provider = harness.id
  const plan = Plans.name(provider)
  const menu: CloneMenuItem[] = [
    hand.hands.length
      ? { detail: hand.where, label: 'Your machine is connected', onClick: hand.show }
      : {
          detail: 'Run code with your files and shell',
          label: 'Run on your machine',
          onClick: hand.show,
        },
    ...payerItems().map((item) => ({
      detail: item.current
        ? 'Pays for this chat'
        : item.value === `plan:${provider}` && plans.error
          ? plans.error
          : (item.detail ?? ''),
      label: item.current
        ? `Paid by ${item.value === 'deployment' ? 'this deployment' : item.label}`
        : item.value === 'deployment'
          ? "Pay with this deployment's key"
          : item.value === 'wallet'
            ? 'Pay with Tempo Wallet'
            : `Pay with your ${item.label}`,
      onClick: () => void choosePayer(item.value ?? item.label),
    })),
    ...(agent.host.plans && signed(provider)
      ? [
          {
            detail: 'Sign out',
            label: `${plan} plan connected`,
            onClick: () => plans.signOut(provider),
          },
        ]
      : []),
  ]
  const panel = (hand.open || plans.pending || unlock.device || unlock.checkout) && (
    <>
      {hand.open && <HandConnect hand={hand} />}
      {plans.pending && <PlanConnect plans={plans} providers={[provider]} />}
      <Prompts machine={unlock} />
    </>
  )
  const clone = {
    before: ready,
    actions: (
      <span className="nc-wallet">
        <button
          className="nc-wallet-button"
          disabled={unlock.working}
          onClick={() => void unlock.command(unlock.connected ? '/logout' : '/login', false)}
          type="button"
          {...(unlock.connected ? { title: 'Log out and revoke the key' } : {})}
        >
          {unlock.connected
            ? Wallet.short(unlock.connected.address)
            : unlock.working
              ? 'Connecting…'
              : 'Connect Tempo Wallet'}
        </button>
      </span>
    ),
    config: agent.config,
    footer: props.footer,
    highlight,
    menu,
    panel,
    picker: {
      bound: agent.bound(),
      choose: agent.choose,
      current: model.id,
      models: agent.models().map((entry) => ({
        detail:
          payer === 'plan'
            ? `${entry.name} · your ${plan} plan`
            : payer === 'wallet'
              ? `${entry.name} · Tempo Wallet`
              : (entry.detail ?? entry.name),
        id: entry.id,
        label: entry.label,
      })),
    },
    ...(props.prompts ? { prompts: props.prompts } : {}),
    ...(asks
      ? {
          sidebar: (
            <input
              aria-label="Access token"
              className={props.theme === 'claude' ? 'cl-token' : 'gpt-token'}
              onChange={(event) => remember(event.target.value)}
              placeholder="Access token"
              type="password"
              value={secret}
            />
          ),
        }
      : {}),
    ...(props.title ? { title: props.title } : {}),
    warm: () => transport.warm(),
  }
  return props.theme === 'claude' ? <Claude {...clone} /> : <ChatGpt {...clone} />
}
