import * as Config from '../client/Config.ts'
import * as LiveEvent from '../client/LiveEvent.ts'
import type * as Transcript from '../client/Transcript.ts'
import * as Cloud from './Cloud.ts'
import type * as Models from './Models.ts'
import * as Payment from './Payment.ts'
import * as Wallet from './Wallet.ts'

export type Runtime = {
  model: () => Models.Model
  options: create.Options
  payment: Payment.Policy
}

export const commands = [
  { detail: 'connect Tempo Wallet and approve a key that pays for this agent', label: '/login' },
  { detail: 'show your MACH and what the key may still spend', label: '/wallet' },
  { detail: 'buy MACH in Tempo Wallet', label: '/fund' },
  { detail: "run this session's code on your machine with nc", label: '/hand' },
  { detail: 'clear the conversation and start a new session', label: '/clear' },
  { detail: 'revoke the key in Tempo Wallet and forget it here', label: '/logout' },
  { detail: 'list the commands', label: '/help' },
] as const

export const limits = `at most ${amount(Wallet.allowance)} MACH, plus ${amount(Wallet.feeAllowance)} ${Wallet.usdc.symbol} for fees, until it expires a day later`

export const unlockCommands = [
  { detail: 'connect Tempo Wallet to unlock paid tools', label: '/login' },
  { detail: 'show your MACH and what the key may still spend', label: '/wallet' },
  { detail: 'buy MACH in Tempo Wallet', label: '/fund' },
  { detail: 'revoke the key in Tempo Wallet and forget it here', label: '/logout' },
] as const

export function amount(atomics: bigint) {
  return Wallet.format(atomics).replace(/\.?0+$/, '')
}

export function create(options: create.Options) {
  const payment = Payment.resolve(options.payment)
  const runtime: Runtime = { model: options.model, options, payment }
  const linked = () => {
    const link = Cloud.restore()
    if (!link) throw new Error('Log in first: type /login.')
    return link
  }
  const config = Config.create({
    history: { key: options.history },
    keep: 300,
    revealMs: 0,
    transport: {
      send: async ({ prompt, push, note, signal }) =>
        Cloud.ask(linked(), {
          handlers: handlers(push, note),
          model: runtime.model(),
          prompt,
          signal,
        }),
      async steer({ prompt, note }) {
        if ((await Cloud.steer(linked(), { model: runtime.model(), prompt })) === 'steered')
          return true
        note('tool', 'The turn is finishing; ask again in a moment.')
        return false
      },
      async resume({ push, note, signal }) {
        const link = Cloud.restore()
        if (link?.open) await Cloud.resume(link, { handlers: handlers(push, note), signal })
      },
      restore(saved) {
        const link = Cloud.restore()
        if (link) Cloud.adopt(link, saved)
      },
      snapshot() {
        const link = Cloud.restore()
        return link && Cloud.snapshot(link)
      },
    },
  })
  return { config, runtime }
}

export declare namespace create {
  type Options = {
    history: string
    model: () => Models.Model
    payment?: Payment.Config
    suggestion?: string
  }
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function until(key: Wallet.AccessKey) {
  return new Date(key.expiry * 1000).toLocaleString(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  })
}

function handlers(
  push: (event: LiveEvent.LiveEvent) => void,
  note: (kind: Transcript.EntryKind, text: string) => void,
): Cloud.Handlers {
  return {
    event: (logged) => {
      const event = LiveEvent.fromLogged(logged)
      if (event) push(event)
    },
    interrupted: () =>
      note(
        'tool',
        "The session's Durable Object reset. Its alarm started it again, and the turn continues from its checkpoint.",
      ),
  }
}
