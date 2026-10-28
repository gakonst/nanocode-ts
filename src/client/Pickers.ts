/**
 * Picker items for the model and thinking level choices of a chat.
 *
 * @module
 */
import type * as Contracts from '../Contracts.ts'

/** Harness and the models that it serves. */
export type Harness = {
  /** Provider of the harness. */
  id: Contracts.ModelProvider
  /** Display name. */
  label: string
  /** Models of the harness. */
  models: Model[]
}

/** Row of a picker. */
export type Item = {
  /** Whether the row is a choice or a group header. */
  kind: 'choice' | 'header'
  /** Display text, and the chosen value when `value` is absent. */
  label: string
  /** Secondary text. */
  detail?: string
  /** Whether the row is the current choice. */
  current?: boolean
  /** Chosen value, when it differs from `label`. */
  value?: string
}

/** Model fields that a picker reads. */
export type Model = Pick<Contracts.ModelEntry, 'id' | 'name' | 'efforts' | 'effort'>

/** Returns the model rows that match `options.query`, grouped under one header for each harness. */
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
    /** Identifier of the current model. */
    model: string
    /** Search text. Each word must appear in a row. */
    query: string
  }
}

/** Returns the thinking level rows of `model`, with the current level marked. */
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
    /** Chosen thinking level. A level that the model does not serve selects its default. */
    thinking?: string | undefined
  }
}
