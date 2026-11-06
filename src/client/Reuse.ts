export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false

  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  let keys = 0
  for (const key in left) {
    if (left[key] === undefined) continue
    keys++
    if (!equal(left[key], right[key])) return false
  }
  for (const key in right) if (right[key] !== undefined) keys--
  return keys === 0
}

export function items<List extends readonly unknown[]>(
  previous: List,
  options: items.Options<List>,
): List {
  const next = options.next
  if (!previous.length) return next.length ? next : previous

  const known = new Map<string, List[number]>()
  for (const item of previous) known.set(options.key(item), item)
  let same = previous.length === next.length
  const out = next.map((item, i) => {
    const old = known.get(options.key(item))
    const kept = old !== undefined && equal(old, item) ? old : item
    if (same && kept !== previous[i]) same = false
    return kept
  })
  return same ? previous : (out as unknown as List)
}

export declare namespace items {
  type Options<List extends readonly unknown[]> = {
    key: (item: List[number]) => string
    next: List
  }
}
