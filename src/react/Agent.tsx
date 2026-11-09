'use client'

import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import * as Config from '../client/Config.ts'
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

export type Selection = { harness: Harness['id']; model: string; thinking: string }

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

type Saved = { bound: Record<string, string>; picked?: string; thinking?: Record<string, string> }

type Instance = ReturnType<typeof create>

const commands = [
  { detail: 'choose harness, model and thinking for a new session', label: '/model' },
  { detail: 'choose the thinking of the next turns', label: '/effort' },
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
  }
}

function create(props: Agent.Props) {
  const history =
    props.theme === 'nanocode'
      ? props.storage
      : `${props.storage}:${props.theme === 'codex' ? 'chatgpt' : 'claude'}`
  const key = `${history}:models`
  const token = `${props.storage}:token`
  const shown =
    props.theme === 'nanocode'
      ? props.harnesses
      : props.harnesses.filter((harness) => harness.id === props.theme)
  const listeners = new Set<() => void>()
  const saved: Saved = { bound: {}, ...JSON.parse(localStorage.getItem(key) ?? '{}') }
  let offered = shown
  let version = 0

  const changed = () => {
    version++
    for (const listener of listeners) listener()
  }

  const persist = () => {
    const ids = new Set(config.getState().conversations.map((item) => item.id))
    saved.bound = Object.fromEntries(Object.entries(saved.bound).filter(([id]) => ids.has(id)))
    localStorage.setItem(key, JSON.stringify(saved))
    changed()
  }

  const models = () => offered.flatMap((harness) => harness.models)

  const current = (): Model => {
    const conversation = config.getState().conversation
    const id = (conversation && saved.bound[conversation]) || saved.picked || props.model
    return models().find((model) => model.id === id) ?? models()[0]!
  }

  const harnessOf = (model: Model) => offered.find((harness) => harness.models.includes(model))!

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
      return { harness: harnessOf(model).id, model: model.id, thinking: thinking(model) }
    },
    session: {
      load: () => ({}),
      save: (session) => {
        const conversation = config.getState().conversation
        if (!session.id || !conversation || saved.bound[conversation]) return changed()
        saved.bound[conversation] = current().id
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
    offer: (status: Plans.Status | undefined) => {
      offered = shown.map((harness): Harness => {
        const plan = props.planHarnesses?.find((entry) => entry.id === harness.id)
        if (!plan || status?.[harness.id].state !== 'authenticated') return harness
        return {
          ...harness,
          models: [
            ...plan.models,
            ...harness.models.filter(
              (model) => !plan.models.some((entry) => entry.id === model.id),
            ),
          ],
        }
      })
    },
    offered: () => offered,
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

  useEffect(() => {
    if (typeof props.token === 'function') void props.token().then(setAsks)
  }, [])

  useEffect(() => {
    if (opened.current && opened.current !== session) hand.reset()
    opened.current = session
  }, [session])

  useEffect(() => {
    if (props.theme === 'nanocode') void config.resume()
  }, [conversation])

  const model = agent.current()
  const harness = agent.harnessOf(model)
  const level = agent.thinking(model)
  const signed = (provider: Plans.Provider) => plans.status?.[provider].state === 'authenticated'

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
          <button
            disabled={busy}
            onClick={reset}
            type="button"
            {...styles.suggestion({ quiet: true })}
          >
            New session
          </button>
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
          else if (!command(text)) void send(text)
        }}
        picker={picker}
        status={`${harness.label}${signed(harness.id) && Plans.serves(harness.id, model.id) ? ' plan' : ''} · ${model.label} · ${level} · ${session ?? 'new session'}${hand.where ? ` · ${hand.where}` : ''} · ${busy ? 'running' : 'idle'}`}
        suggestions={[
          ...(props.prompts ?? []).map((prompt) => ({
            disabled: busy,
            label: prompt,
            onClick: () => void send(prompt),
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
    ...(agent.host.plans
      ? [
          signed(provider)
            ? {
                detail: 'Sign out',
                label: `${plan} plan connected`,
                onClick: () => plans.signOut(provider),
              }
            : {
                detail: plans.error ?? `Pay for the model with your ${plan} subscription`,
                label: `Use your ${plan} plan`,
                onClick: () => plans.signIn(provider),
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
          signed(provider) && Plans.serves(provider, entry.id) && props.planHarnesses
            ? `${entry.name} · your ${plan} plan`
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
