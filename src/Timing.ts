export type Value = { count: number; total_ms: number; max_ms: number }
export type Snapshot = Record<string, Value>

export function create() {
  const state: { values: Snapshot } = {
    values: {},
  }
  const internal = {}
  const self = {
    record(name: string, milliseconds: number): void {
      const value = (state.values[name] ??= { count: 0, total_ms: 0, max_ms: 0 })
      value.count++
      value.total_ms += milliseconds
      value.max_ms = Math.max(value.max_ms, milliseconds)
    },

    snapshot(): Snapshot {
      return Object.fromEntries(
        Object.entries(state.values).map(([name, value]) => [name, { ...value }]),
      )
    },
  }
  return self
}
export type Timings = ReturnType<typeof create>

export function difference(
  after: Snapshot,
  before: Snapshot,
): Record<string, { count: number; total_ms: number }> {
  return Object.fromEntries(
    Object.entries(after)
      .map(
        ([name, value]) =>
          [
            name,
            {
              count: value.count - (before[name]?.count ?? 0),
              total_ms: value.total_ms - (before[name]?.total_ms ?? 0),
            },
          ] as const,
      )
      .filter(([, value]) => value.count > 0),
  )
}
