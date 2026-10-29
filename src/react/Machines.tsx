'use client'

import {
  Fragment,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type * as Relay from '../client/Relay.ts'
import type * as Tool from '../client/Tool.ts'
import type * as Transcript from '../client/Transcript.ts'
import {
  Cloud,
  type Keyring,
  Machine,
  Models,
  Payment,
  Payments,
  Wallet,
} from '../machines/index.ts'
import type * as Mcp from '../machines/Mcp.ts'
import { useConfig, useConversations, useHand, usePart, useSend, useTranscript } from './index.tsx'

export function useMachine(runtime: Machine.Runtime, options: useMachine.Options) {
  const { model } = options
  const { servers } = runtime.payment
  const config = useConfig()
  const { isPending: busy } = useSend()
  const { current: conversation } = useConversations()
  const note = config.note
  const [connected, setConnected] = useState<Wallet.AccessKey>()
  const [working, setWorking] = useState(false)
  const [device, setDevice] = useState<Wallet.Prompt>()
  const [checkout, setCheckout] = useState<{ address: string; url: string }>()
  const [link, setLink] = useState<Cloud.Link | undefined>(() => Cloud.restore())
  const metered = useMemo(() => link && Cloud.meter(link), [link?.token])
  const machine = useRef<Relay.Source>({
    hand: async () => {
      const current = Cloud.restore()
      return current && (await Cloud.hand(current))
    },
    hands: async () => {
      const current = Cloud.restore()
      return current ? await Cloud.hands(current) : []
    },
    listing: async () => {
      const current = Cloud.restore()
      return current ? await Cloud.listing(current) : { hands: [], toolsOnly: [] }
    },
  }).current
  const hand = useHand(machine)
  const { send } = useSend()

  useEffect(() => {
    Wallet.preload()
    return Wallet.onPrompt(setDevice)
  }, [])

  useEffect(() => {
    hand.reset()
    void config.resume()
  }, [conversation])

  useEffect(() => {
    const restored = config.getState().entries.length > 0
    const saved = Wallet.restore()
    if (!saved)
      return options.greet === false
        ? undefined
        : note(
            'tool',
            `Not logged in. Type /login to connect your Tempo Wallet. It asks you to approve a key that this site's Worker keeps encrypted and pays with, ${Machine.limits}, and only for payments. The agent then pays for its own model and every service it calls.`,
          )
    setConnected(saved)
    if (!restored && options.greet !== false)
      note(
        'tool',
        `Logged in as ${Wallet.short(saved.address)} with key ${Wallet.short(saved.keyAddress)} until ${Machine.until(saved)}. Type /wallet to see your MACH.`,
      )
    if (!Cloud.restore())
      void attach(saved).catch((error: unknown) => note('error', Machine.message(error)))
  }, [])

  async function attach(account: Wallet.AccessKey) {
    setLink(Cloud.restore() ?? (await Cloud.enable(account)))
  }

  async function login() {
    if (connected)
      return note(
        'tool',
        `Already logged in as ${Wallet.short(connected.address)}. Type /logout first to use another wallet.`,
      )
    const pending = await approve(note)
    setConnected(pending)
    if (!Cloud.restore()) await attach(pending)
    await greet(pending, note, false, runtime.options.suggestion)
  }

  async function logout() {
    const saved = connected ?? Wallet.restore()
    if (!saved) return note('tool', 'Not logged in.')
    const current = link ?? Cloud.restore()
    if (current)
      await Cloud.logout(current).catch((error: unknown) =>
        note('error', `The Worker did not forget the key (${Machine.message(error)}).`),
      )
    note('tool', 'Opening Tempo Wallet to revoke the key.')
    try {
      await Wallet.revoke(saved)
      note('tool', 'Tempo Wallet revoked the key.')
    } catch (error) {
      note(
        'error',
        `Tempo Wallet did not revoke the key (${Machine.message(error)}). It stays valid until ${Machine.until(saved)} with what is left of its limit, but this page no longer keeps it.`,
      )
    }
    Wallet.forget()
    Cloud.forget()
    setLink(undefined)
    setConnected(undefined)
    hand.reset()
  }

  function clear() {
    config.clear()
    hand.reset()
    note('tool', link ? "New session. The previous one's files stay in the Worker." : 'Cleared.')
  }

  async function wallet() {
    if (!connected) return note('tool', 'Not logged in. Type /login.')
    const { balance, fees, remaining } = await Wallet.balances(connected)
    note(
      'tool',
      `${Wallet.short(connected.address)} holds ${Wallet.format(balance)} MACH and ${Wallet.format(fees)} ${Wallet.usdc.symbol}. Key ${Wallet.short(connected.keyAddress)} may spend ${Wallet.format(remaining)} MACH more until ${Machine.until(connected)}.`,
    )
    if (link) {
      const { spent } = await Cloud.status(link)
      const total = Object.values(spent).reduce((sum, value) => sum + BigInt(value), 0n)
      note(
        'tool',
        `The agent has paid ${Wallet.format(total)} MACH: ${
          Object.entries(spent)
            .map(([host, value]) => `${host.split('.')[0]} ${Wallet.format(BigInt(value))}`)
            .join(', ') || 'nothing yet'
        }.`,
      )
    }
  }

  async function fund() {
    await fundWallet(connected, note, setCheckout)
  }

  function open(event: MouseEvent<HTMLAnchorElement>) {
    guard(event, note)
  }

  async function command(text: string, echo = true) {
    setCheckout(undefined)
    if (echo) note('user', text)
    const name = text.split(/\s/)[0]
    setWorking(true)
    try {
      if (name === '/login') await login()
      else if (name === '/logout') await logout()
      else if (name === '/wallet') await wallet()
      else if (name === '/fund') await fund()
      else if (name === '/hand')
        link
          ? hand.show()
          : note(
              'tool',
              'Log in first: type /login. The machine then runs the session the Worker keeps for this conversation.',
            )
      else if (name === '/clear') clear()
      else
        note(
          'tool',
          Machine.commands.map((entry) => `${entry.label.padEnd(8)} ${entry.detail}`).join('\n'),
        )
    } catch (error) {
      note('error', Models.explain(error).message)
    }
    setDevice(undefined)
    setWorking(false)
  }

  function submit(text: string) {
    if (text.startsWith('/')) return void command(text)
    if (!connected || !link) {
      note('user', text)
      return note(
        'error',
        connected
          ? 'The Worker is still taking the key; try again in a moment.'
          : 'Log in first: type /login.',
      )
    }
    void send(text)
  }

  const detail = `${model.model}${hand.where ? ` · ${hand.where}` : ''}`

  return {
    busy,
    checkout,
    command,
    connected,
    detail,
    device,
    hand,
    keyed: false,
    locked: false,
    open,
    ready: Boolean(link),
    servers,
    spend: metered,
    status: connected ? `${detail} · ${Wallet.short(connected.address)}` : 'not logged in · /login',
    submit,
    working,
  }
}

export declare namespace useMachine {
  type Options = {
    greet?: boolean | undefined
    model: Models.Model
  }

  type ReturnType = MachineState
}

type MachineState = ReturnType<typeof useMachine>

type Note = (kind: Transcript.Entry['kind'], text: string) => void

async function approve(note: Note): Promise<Wallet.AccessKey> {
  let pending = Wallet.restore()
  if (!pending) {
    note(
      'tool',
      Wallet.framed()
        ? "X's player cannot show Tempo Wallet, so Tempo Wallet gives you a code instead. ⌘-click the link below (Ctrl-click on Windows) to open it in a normal tab, or open it on your phone, and approve the key with your passkey."
        : 'Opening Tempo Wallet. Approve the key with your passkey.',
    )
    pending = await Wallet.connect()
    note(
      'tool',
      `Tempo Wallet approved key ${Wallet.short(pending.keyAddress)} for ${Wallet.short(pending.address)}: ${Machine.limits}, at ${Machine.until(pending)}. Its first payment puts it on Tempo.`,
    )
  }
  return pending
}

async function greet(connected: Wallet.AccessKey, note: Note, keyed: boolean, suggestion?: string) {
  const { balance } = await Wallet.balances(connected)
  note(
    'tool',
    balance === 0n
      ? 'Your wallet holds no MACH yet. Type /fund to buy some.'
      : `Your wallet holds ${Wallet.format(balance)} MACH. ${keyed ? 'Paid tools are unlocked. ' : ''}Ask anything${suggestion ? `, or try "${suggestion}"` : ''}.`,
  )
}

async function fundWallet(
  connected: Wallet.AccessKey | undefined,
  note: Note,
  setCheckout: (checkout: { address: string; url: string }) => void,
) {
  const saved = connected ?? Wallet.restore()
  if (!saved) return note('tool', 'Not logged in. Type /login first.')
  if (Wallet.framed()) {
    note(
      'tool',
      "X's player cannot show Tempo Wallet. ⌘-click the link below (Ctrl-click on Windows) to buy MACH in a normal tab, then type /wallet to see your balance.",
    )
    return setCheckout({ address: saved.address, url: Wallet.fundingUrl(saved) })
  }
  note('tool', 'Opening MACH checkout in Tempo Wallet.')
  await Wallet.fund(saved)
}

function guard(event: MouseEvent<HTMLAnchorElement>, note: Note) {
  const pointer = (event.nativeEvent as PointerEvent).pointerType
  const mouse = pointer ? pointer === 'mouse' : matchMedia('(pointer: fine)').matches
  if (
    !mouse ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return
  if (!Wallet.framed() || !Wallet.sandboxed()) return
  event.preventDefault()
  note(
    'tool',
    "That link would open in a tab that keeps X's sandbox, where Tempo Wallet cannot sign you in. ⌘-click it (Ctrl-click on Windows) to open a normal tab, or open it on your phone.",
  )
}

export type Keyed = {
  busy: boolean
  command(text: string, echo?: boolean): Promise<void>
  keyed: boolean
  locked: boolean
  scripts?: boolean
  servers: readonly Mcp.Server[]
  submit(text: string): void
  working: boolean
}

export type Unlocking = Keyed & {
  checkout: { address: string; url: string } | undefined
  connected: Wallet.AccessKey | undefined
  device: Wallet.Prompt | undefined
  open(event: MouseEvent<HTMLAnchorElement>): void
  commands: typeof Machine.unlockCommands
  handles(text: string): boolean
}

export function useUnlock(
  keyring: Keyring.Keyring,
  options: { servers?: readonly Mcp.Server[]; scripts?: boolean } = {},
): Unlocking {
  const servers = options.servers ?? Payment.resolve({ inference: 'apiKey' }).servers
  const config = useConfig()
  const { send, isPending: busy } = useSend()
  const { current: conversation } = useConversations()
  const note = config.note
  const [connected, setConnected] = useState<Wallet.AccessKey>()
  const [working, setWorking] = useState(false)
  const [device, setDevice] = useState<Wallet.Prompt>()
  const [checkout, setCheckout] = useState<{ address: string; url: string }>()

  useEffect(() => {
    Wallet.preload()
    return Wallet.onPrompt(setDevice)
  }, [])

  useEffect(() => {
    const saved = Wallet.restore()
    if (!saved) return
    void keyring
      .register(saved)
      .then(() => setConnected(saved))
      .catch((error: unknown) => note('error', Machine.message(error)))
  }, [])

  useEffect(() => {
    if (connected)
      void keyring
        .register(connected)
        .catch((error: unknown) => note('error', Machine.message(error)))
  }, [conversation, connected])

  async function login() {
    if (connected)
      return note(
        'tool',
        `Connected as ${Wallet.short(connected.address)}. Type /logout first to use another wallet.`,
      )
    const pending = await approve(note)
    await keyring.register(pending)
    setConnected(pending)
    await greet(pending, note, true)
  }

  async function logout() {
    const saved = connected ?? Wallet.restore()
    if (!saved) return note('tool', 'Not connected.')
    note('tool', 'Opening Tempo Wallet to revoke the key.')
    try {
      await Wallet.revoke(saved)
      note('tool', 'Tempo Wallet revoked the key.')
    } catch (error) {
      note(
        'error',
        `Tempo Wallet did not revoke the key (${Machine.message(error)}). It stays valid until ${Machine.until(saved)} with what is left of its limit, but this page no longer keeps it.`,
      )
    }
    await keyring.logout().catch(() => undefined)
    Wallet.forget()
    setConnected(undefined)
  }

  async function wallet() {
    if (!connected) return note('tool', 'Not connected. Type /login.')
    const { balance, fees, remaining } = await Wallet.balances(connected)
    const spent = await keyring.status().catch(() => undefined)
    const total = Object.values(spent?.spent ?? {}).reduce((sum, value) => sum + BigInt(value), 0n)
    note(
      'tool',
      `${Wallet.short(connected.address)} holds ${Wallet.format(balance)} MACH and ${Wallet.format(fees)} ${Wallet.usdc.symbol}. Key ${Wallet.short(connected.keyAddress)} may spend ${Wallet.format(remaining)} MACH more until ${Machine.until(connected)}; this site's server has paid ${Wallet.format(total)} MACH for tools with it.`,
    )
  }

  function handles(text: string) {
    return Machine.unlockCommands.some((entry) => entry.label === text.split(/\s/)[0])
  }

  async function command(text: string, echo = true) {
    setCheckout(undefined)
    if (echo) note('user', text)
    const name = text.split(/\s/)[0]
    setWorking(true)
    try {
      if (name === '/login') await login()
      else if (name === '/logout') await logout()
      else if (name === '/wallet') await wallet()
      else if (name === '/fund') await fundWallet(connected, note, setCheckout)
    } catch (error) {
      note('error', Models.explain(error).message)
    }
    setDevice(undefined)
    setWorking(false)
  }

  return {
    busy,
    checkout,
    command,
    commands: Machine.unlockCommands,
    connected,
    device,
    handles,
    keyed: true,
    locked: !connected,
    open: (event) => guard(event, note),
    scripts: options.scripts ?? false,
    servers,
    submit: (text) => void send(text),
    working,
  }
}

const bars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

export type Source = Pick<Payments.Client, 'ledger' | 'subscribe'>

export function useSpend(source: Source, window: number = Payments.window) {
  const ledger = useSyncExternalStore(source.subscribe, source.ledger, source.ledger)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const recent = ledger.services.flatMap((service) =>
    service.charges.filter((item) => now - item.at < window),
  )
  const rate = (recent.reduce((sum, item) => sum + item.amount, 0n) * 60_000n) / BigInt(window)
  const services = [...ledger.services]
    .sort((a, b) => (a.spent === b.spent ? 0 : a.spent > b.spent ? -1 : 1))
    .map((service) => ({
      ...service,
      live: service.charges.some((item) => now - item.at < 2000),
      spark: spark(service, now, window),
    }))
  return { ledger, rate, services }
}

function spark(service: Payments.Service, now: number, window: number) {
  const columns = Math.round(window / 1000)
  const buckets = Array.from({ length: columns }, () => 0n)
  for (const item of service.charges) {
    const age = Math.floor((now - item.at) / 1000)
    if (age >= 0 && age < columns) buckets[columns - 1 - age]! += item.amount
  }
  const top = buckets.reduce((max, value) => (value > max ? value : max), 0n)
  return buckets
    .map((value) =>
      value === 0n || top === 0n
        ? ' '
        : bars[Math.min(bars.length - 1, Number((value * BigInt(bars.length)) / (top + 1n)))],
    )
    .join('')
}

export function Spend(props: Spend.Props) {
  const part = usePart()
  const { ledger, rate, services } = useSpend(props.source, props.window)
  const width = Math.max(0, ...services.map((service) => service.name.length))
  return (
    <div aria-label="Spend" {...part('spend')}>
      <p {...part('spendTitle')}>
        <span {...part('spendAccent')}>⚡</span> {Wallet.format(ledger.total)} MACH streamed ·{' '}
        {ledger.calls} paid calls · {services.length} services · {Wallet.format(rate)} MACH/min
      </p>
      {services.length === 0 && (
        <p {...part('spendEmpty')}>Nothing paid yet. Each service shows up here as it charges.</p>
      )}
      {services.map((service) => (
        <p key={service.name}>
          <span {...part('spendDot', { live: service.live })}>●</span> {service.name.padEnd(width)}{' '}
          <span {...part('spendSpark')}>{service.spark}</span>{' '}
          {Wallet.format(service.spent).padStart(10)} MACH{' '}
          <span {...part('spendCalls')}>{service.calls} calls</span>
        </p>
      ))}
    </div>
  )
}

export declare namespace Spend {
  type Props = {
    source: Source
    window?: number
  }
}

export function Meter(props: Meter.Props) {
  const part = usePart()
  const { ledger, rate, services } = useSpend(props.source, props.window)
  const [open, setOpen] = useState(false)
  return (
    <div aria-label="Spend" {...part('meter', { open })}>
      <button
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        type="button"
        {...part('meterHead')}
      >
        <span {...part('meterBolt')}>⚡</span>
        <span>
          {Wallet.format(ledger.total)} MACH · {ledger.calls} paid calls · {services.length}{' '}
          services · {Wallet.format(rate)} MACH/min
        </span>
        {props.chevron}
      </button>
      {open && (
        <div {...part('meterRows')}>
          {services.length === 0 && (
            <p {...part('meterEmpty')}>
              Nothing paid yet. Each service shows up here as it charges.
            </p>
          )}
          {services.map((service) => (
            <p key={service.name} {...part('meterRow', { live: service.live })}>
              <span {...part('meterDot')}>●</span>
              <span {...part('meterName')}>{service.name}</span>
              <span {...part('meterSpark')}>{service.spark}</span>
              <span>{Wallet.format(service.spent)} MACH</span>
              <small>{service.calls} calls</small>
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

export declare namespace Meter {
  type Props = {
    source: Source
    window?: number
    chevron?: ReactNode
  }
}

export function Prompts(props: Prompts.Props) {
  const part = usePart()
  const { checkout, device, open } = props.machine
  const link = device && (device.verificationUriFull ?? device.verificationUri)
  return (
    <>
      {device && link && (
        <p {...part('prompt')}>
          Approve in Tempo Wallet:{' '}
          <a href={link} onClick={open} rel="noreferrer" target="_blank">
            {link.replace(/^https:\/\//, '')}
          </a>{' '}
          · code <b>{device.userCode}</b>
        </p>
      )}
      {checkout && (
        <p {...part('prompt')}>
          Buy MACH in Tempo Wallet:{' '}
          <a href={checkout.url} onClick={open} rel="noreferrer" target="_blank">
            checkout for {Wallet.short(checkout.address)}
          </a>
        </p>
      )}
    </>
  )
}

export declare namespace Prompts {
  type Props = {
    machine: Pick<useMachine.ReturnType, 'checkout' | 'device' | 'open'>
  }
}

export function SignIn(props: SignIn.Props) {
  const part = usePart()
  const { machine } = props
  return (
    <div {...part('signIn')}>
      <p>
        {props.children ?? (
          <>
            This chat is a nanocode agent in Code Mode. It pays for its model and every service its
            scripts call from your Tempo Wallet, in MACH over MPP. Sign in to approve a key that may
            spend {Machine.limits}.
          </>
        )}
      </p>
      <button
        disabled={machine.working}
        onClick={() => void machine.command('/login', false)}
        type="button"
        {...part('signInButton')}
      >
        {machine.working ? 'Waiting for Tempo Wallet…' : 'Sign in with Tempo'}
      </button>
    </div>
  )
}

export declare namespace SignIn {
  type Props = {
    machine: useMachine.ReturnType
    children?: ReactNode
  }
}

export function Account(props: Account.Props) {
  const part = usePart()
  const { machine } = props
  const connected = machine.connected
  if (!connected) {
    return (
      <div {...part('account')}>
        <button
          disabled={machine.working}
          onClick={() => void machine.command('/login', false)}
          type="button"
          {...part('accountLogin')}
        >
          Sign in with Tempo
        </button>
      </div>
    )
  }
  return (
    <div {...part('account')}>
      <div {...part('accountWho')}>
        <span aria-hidden="true" {...part('accountAvatar')}>
          {connected.address.slice(2, 4).toUpperCase()}
        </span>
        <span>
          <strong>{Wallet.short(connected.address)}</strong>
          <small>{machine.detail}</small>
        </span>
      </div>
      <div {...part('accountActions')}>
        <button
          disabled={machine.working}
          onClick={() => void machine.command('/wallet', false)}
          type="button"
        >
          Balance
        </button>
        <button
          disabled={machine.working}
          onClick={() => void machine.command('/fund', false)}
          type="button"
        >
          Add MACH
        </button>
        <button
          disabled={machine.working}
          onClick={() => void machine.command('/logout', false)}
          type="button"
        >
          Log out
        </button>
      </div>
    </div>
  )
}

export declare namespace Account {
  type Props = {
    machine: useMachine.ReturnType
  }
}

export function Unlock(props: Unlock.Props) {
  const part = usePart()
  const { machine } = props
  if (!machine.locked) return null
  return (
    <p {...part('unlock')}>
      <span>
        Connect Tempo Wallet to unlock tools: {Payment.unlocks(machine.servers, machine.scripts)}.
      </span>
      <button
        disabled={machine.working}
        onClick={() => void machine.command('/login', false)}
        type="button"
        {...part('unlockButton')}
      >
        {machine.working ? 'Waiting for Tempo Wallet…' : 'Connect'}
      </button>
    </p>
  )
}

export declare namespace Unlock {
  type Props = {
    machine: Keyed
  }
}

function blocked(cell: Tool.Cell | undefined): boolean {
  return Boolean(cell && (Payment.needsWallet(cell.output) || cell.children.some(blocked)))
}

export function needsWallet(entry: Transcript.Entry) {
  return blocked(entry.tool)
}

export function WalletCard(props: WalletCard.Props) {
  const part = usePart()
  const { entries } = useTranscript()
  const { machine } = props
  if (!machine.keyed || !needsWallet(props.entry)) return null
  const latest = [...entries].reverse().find(needsWallet) === props.entry
  const retried = entries
    .slice(entries.indexOf(props.entry) + 1)
    .some((entry) => entry.kind === 'user')
  if (!machine.locked) {
    if (!latest || retried) return null
    return (
      <div {...part('walletCard', { connected: true })}>
        <p {...part('walletCardTitle')}>Tempo Wallet connected</p>
        <p {...part('walletCardText')}>
          Paid tools are unlocked. The model still runs on this site&apos;s API key.
        </p>
        <div {...part('walletCardActions')}>
          <button
            disabled={machine.busy}
            onClick={() =>
              machine.submit(
                'Retry the paid tool call that needed a Tempo Wallet; it is connected now.',
              )
            }
            type="button"
            {...part('walletCardButton')}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }
  return (
    <div {...part('walletCard', { connected: false })}>
      <p {...part('walletCardTitle')}>This tool is paid with Tempo</p>
      <p {...part('walletCardText')}>
        Connect Tempo Wallet to unlock {Payment.unlocks(machine.servers, machine.scripts)}. You
        approve a key that may spend {Machine.limits}; the model still runs on this site&apos;s API
        key.
      </p>
      <div {...part('walletCardActions')}>
        <button
          disabled={machine.working}
          onClick={() => void machine.command('/login', false)}
          type="button"
          {...part('walletCardButton')}
        >
          {machine.working ? 'Waiting for Tempo Wallet…' : 'Connect Tempo Wallet'}
        </button>
      </div>
    </div>
  )
}

export declare namespace WalletCard {
  type Props = {
    machine: Keyed
    entry: Transcript.Entry
  }
}

export function walletCards(machine: Keyed) {
  return (entry: Transcript.Entry) => (
    <Fragment>{needsWallet(entry) && <WalletCard entry={entry} machine={machine} />}</Fragment>
  )
}
