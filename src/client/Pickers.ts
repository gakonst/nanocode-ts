import type * as Contracts from '../Contracts.ts'

export type Harness = {
  id: Contracts.ModelProvider
  label: string
  models: Model[]
}

export type Item = {
  kind: 'choice' | 'header'
  label: string
  detail?: string
  current?: boolean
  value?: string
}

export type Model = Pick<Contracts.ModelEntry, 'id' | 'name' | 'efforts' | 'effort'>

export function models(harnesses: readonly Harness[], options: models.Options): Item[] {
  const { model, query } = options
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return harnesses.flatMap((entry) => {
    const items = entry.models
      .map((candidate) => ({
        kind: 'choice' as const,
        label: candidate.id,
        detail: `${candidate.name} · thinking ${candidate.efforts.join('/')}`,
        current: candidate.id === model,
      }))
      .filter((item) =>
        words.every((word) => `${item.label} ${item.detail}`.toLowerCase().includes(word)),
      )
    return items.length ? [{ kind: 'header' as const, label: entry.label }, ...items] : []
  })
}

export declare namespace models {
  type Options = {
    model: string
    query: string
  }
}

export function thinking(model: Model | undefined, options: thinking.Options = {}): Item[] {
  const current =
    model && options.thinking && model.efforts.includes(options.thinking as Model['effort'])
      ? options.thinking
      : model?.effort
  return (model?.efforts ?? []).map((level) => ({
    kind: 'choice',
    label: level,
    detail: level === model?.effort ? 'default' : '',
    current: level === current,
  }))
}

export declare namespace thinking {
  type Options = {
    thinking?: string | undefined
  }
}
