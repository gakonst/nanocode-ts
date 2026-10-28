import * as Wallet from './Wallet.ts'

export const endpoint = 'https://openai.mpp.tempo.xyz/v1'

export const anthropic = 'https://anthropic.mpp.tempo.xyz/v1/messages'

export type Model = {
  about: string
  label: string
  model: string
  provider: 'claude' | 'codex'
  thinking: 'low'
}

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

export const luna: Model = catalog.codex[0]

export function explain(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  if (
    /insufficient funds for gas/.test(text) ||
    (/InsufficientBalance/.test(text) && text.toLowerCase().includes(Wallet.usdc.address))
  )
    return new Error(
      `Putting the key on Tempo before its first payment needs a little ${Wallet.usdc.symbol} for its fee, which Tempo Wallet did not sponsor, and your wallet holds too little. Add ${Wallet.usdc.symbol} in Tempo Wallet, then ask again.`,
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
    return new Error(
      'The key is not on Tempo yet, and this service does not publish keys. Ask again.',
      {
        cause: error,
      },
    )
  return error instanceof Error ? error : new Error(text)
}
