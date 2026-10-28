/**
 * Models that nanocode machines offers, and the text of payment errors.
 *
 * @module
 */
import * as Wallet from './Wallet.ts'

/** Base URL of the paid OpenAI API. */
export const endpoint = 'https://openai.mpp.tempo.xyz/v1'

/** URL of the paid Anthropic Messages API. */
export const anthropic = 'https://anthropic.mpp.tempo.xyz/v1/messages'

/** Model of a turn, with its display text. */
export type Model = {
  about: string
  label: string
  model: string
  provider: 'claude' | 'codex'
  thinking: 'low'
}

/** Models by provider, in display order. */
export const catalog = {
  claude: [
    {
      about: 'Fastest for quick answers',
      label: 'Haiku 5.5',
      model: 'claude-haiku-5-5',
      provider: 'claude',
      thinking: 'low',
    },
    {
      about: 'Smart, efficient model for everyday use',
      label: 'Sonnet 5.5',
      model: 'claude-sonnet-5-5',
      provider: 'claude',
      thinking: 'low',
    },
  ],
  codex: [
    {
      about: 'Fast for everyday questions',
      label: 'Luna',
      model: 'gpt-6-luna',
      provider: 'codex',
      thinking: 'low',
    },
    {
      about: 'Thinks longer for harder problems',
      label: 'Sol',
      model: 'gpt-6.1-sol',
      provider: 'codex',
      thinking: 'low',
    },
  ],
} as const satisfies Record<string, readonly Model[]>

/** Default model. */
export const luna: Model = catalog.codex[0]

/** Returns an error whose message states the fix for a failed payment or key publication. */
export function explain(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  if (
    /insufficient funds for gas/.test(text) ||
    (/InsufficientBalance/.test(text) && text.toLowerCase().includes(Wallet.usdc.address))
  )
    return new Error(
      `Publishing the key needs a little ${Wallet.usdc.symbol} for its fee, and your wallet holds too little. Add ${Wallet.usdc.symbol} in Tempo Wallet, then type /login again.`,
      { cause: error },
    )
  if (/InsufficientBalance/.test(text))
    return new Error(
      'Your Tempo Wallet holds too little MACH for this payment. Type /fund to buy MACH, then ask again.',
      { cause: error },
    )
  if (/SpendingLimitExceeded/.test(text))
    return new Error(
      "The key's limit is spent. Type /logout, then /login to approve another key.",
      { cause: error },
    )
  if (/keyAuthorization is not allowed/.test(text))
    return new Error('The key is not on Tempo yet. Type /login to publish it.', { cause: error })
  return error instanceof Error ? error : new Error(text)
}
