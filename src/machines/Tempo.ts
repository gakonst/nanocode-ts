import type * as Contracts from '../Contracts.ts'

export const gateway = 'https://gateway.tempo-dev.workers.dev'

export const endpoint = `${gateway}/v1`

export const anthropic = `${gateway}/v1/messages`

export const listing = `${gateway}/api/auction/models`

export const efforts: readonly Contracts.Thinking[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export type Entry = {
  detail?: string
  effort: Contracts.Thinking
  efforts: Contracts.Thinking[]
  id: string
  label: string
  name: string
}

export type Harness = {
  id: Contracts.ModelProvider
  label: string
  models: Entry[]
}

type Offer = {
  model: string
  price: string | undefined
  provider: string
  upstream: string
}

type Listed = {
  house?: unknown
  id?: unknown
  provider?: unknown
  upstream?: unknown
}

type Row = {
  builtin: Contracts.ModelEntry | undefined
  id: string
  preferred: boolean
  price: string | undefined
  provider: string
  upstream: string
}

export async function list(
  models: Contracts.ModelCatalog,
  options: list.Options = {},
): Promise<Harness[]> {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis)

  const response = await send(listing, {
    headers: { accept: 'application/json' },
    ...(options.signal ? { signal: options.signal } : {}),
  }).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`listing models at ${listing}: ${reason}`, { cause: error })
  })
  if (!response.ok) throw new Error(`listing models at ${listing}: HTTP ${response.status}`)
  const body = await response.json().catch((error: unknown) => {
    throw new Error(`${listing} did not return a model list`, { cause: error })
  })

  const found = offers(body)
  if (!found.length) throw new Error(`${listing} lists no models`)
  return groups(models, rows(models, found))
}

export declare namespace list {
  type Options = {
    fetch?: typeof fetch | undefined
    signal?: AbortSignal | undefined
  }
}

function offers(body: unknown): Offer[] {
  const entries = (body as { models?: unknown } | null)?.models
  if (!Array.isArray(entries)) throw new Error(`${listing} returned no model list`)

  const found: Offer[] = []
  for (const entry of entries as (Listed | null)[]) {
    const id = entry?.id
    if (typeof id !== 'string' || !id.trim())
      throw new Error(`${listing} listed a model without an id`)
    if (id.startsWith('boundless/')) continue
    if (typeof entry?.provider !== 'string')
      throw new Error(`${listing} names no provider for ${id}`)
    if (found.some((known) => known.model === id)) continue
    found.push({
      model: id,
      price: price(entry.house),
      provider: entry.provider,
      upstream: typeof entry.upstream === 'string' ? entry.upstream : id,
    })
  }
  return found
}

function price(rates: unknown) {
  const { input, output } = (rates ?? {}) as { input?: unknown; output?: unknown }
  return typeof input === 'number' && typeof output === 'number'
    ? `$${input}/$${output}`
    : undefined
}

function alias(models: Contracts.ModelCatalog, id: string) {
  const name = id.split('/').at(-1) ?? id
  const entries = (harness: Contracts.ModelProvider) =>
    models.harnesses.find((entry) => entry.id === harness)?.models ?? []

  return (
    entries('codex').find((model) => model.id === name && model.gateways.includes('direct')) ??
    entries('claude').find((model) => model.id === name.replaceAll('.', '-'))
  )
}

function rows(models: Contracts.ModelCatalog, offers: readonly Offer[]): Row[] {
  const routed = (builtin: Contracts.ModelEntry) =>
    ['vercel/', 'openrouter/']
      .map((prefix) =>
        offers.find(
          (offer) =>
            offer.model.startsWith(prefix) && alias(models, offer.upstream)?.id === builtin.id,
        ),
      )
      .find((offer) => offer !== undefined)

  const found: Row[] = []
  for (const offer of offers) {
    const builtin = alias(models, offer.upstream)
    const route = builtin ? routed(builtin) : undefined
    const row: Row =
      builtin && route?.provider === offer.provider
        ? {
            builtin,
            id: builtin.id,
            preferred: true,
            price: route.price,
            provider: offer.provider,
            upstream: offer.upstream,
          }
        : {
            builtin,
            id: offer.model,
            preferred: offer.model.startsWith(`${offer.provider}/`),
            price: offer.price,
            provider: offer.provider,
            upstream: offer.upstream,
          }

    const known = found.findIndex(
      (entry) =>
        entry.provider === row.provider &&
        (entry.builtin && row.builtin
          ? entry.builtin.id === row.builtin.id
          : entry.upstream === row.upstream),
    )
    if (known === -1) found.push(row)
    else if (!found[known]!.preferred && row.preferred) found[known] = row
  }
  return found
}

function groups(models: Contracts.ModelCatalog, rows: readonly Row[]): Harness[] {
  const native = (row: Row) => row.builtin !== undefined && row.id === row.builtin.id
  const detail = (row: Row) =>
    row.price ? { detail: `${row.price} per 1M input/output tokens` } : {}

  const builtins = models.harnesses.map((harness) => ({
    id: harness.id,
    label: harness.id === 'claude' ? 'Claude' : 'Codex',
    models: harness.models.flatMap((model) => {
      const row = rows.find((entry) => native(entry) && entry.id === model.id)
      return row
        ? [
            {
              ...detail(row),
              effort: model.effort,
              efforts: model.efforts,
              id: model.id,
              label: model.name,
              name: model.name,
            },
          ]
        : []
    }),
  }))

  const providers: Harness[] = []
  for (const row of rows) {
    if (native(row)) continue
    const entry = {
      ...detail(row),
      effort: 'low' as const,
      efforts: [...efforts],
      id: row.id,
      label: row.id,
      name: row.id,
    }
    const group = providers.find((harness) => harness.label === `Tempo · ${row.provider}`)
    if (group) group.models.push(entry)
    else providers.push({ id: 'codex', label: `Tempo · ${row.provider}`, models: [entry] })
  }
  return [...builtins, ...providers].filter((harness) => harness.models.length)
}
