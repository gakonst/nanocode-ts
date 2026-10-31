import type * as Contracts from '../Contracts.ts'

export type Control = {
  ask(id: number, options: ask.Options): Promise<Contracts.SubagentAnswer>
  close(id: number): Promise<readonly Contracts.SubagentSummary[]>
  interrupt(id: number): Promise<readonly Contracts.SubagentSummary[]>
  list(options?: list.Options): Promise<readonly Contracts.SubagentEntry[]>
  message(id: number, options: message.Options): Promise<Contracts.SubagentReceipt>
}

export declare namespace ask {
  type Options = { question: string; signal?: AbortSignal | undefined }
}

export declare namespace list {
  type Options = { signal?: AbortSignal | undefined }
}

export declare namespace message {
  type Options = { priority?: Contracts.SubagentPriority | undefined; prompt: string }
}

export type Update = {
  agent?: {
    id?: unknown
    model?: unknown
    parent?: unknown
    reasoning_mode?: unknown
    role?: unknown
    task?: unknown
    thinking?: unknown
  }
  id?: unknown
  message?: { thread?: { participants?: { agent_id?: unknown; kind?: unknown }[] } }
  parent?: unknown
  status?: unknown
  type?: unknown
}

export function belongs(update: Update, options: belongs.Options): boolean {
  if (update.type === 'message')
    return (update.message?.thread?.participants ?? []).some(
      (participant) =>
        participant.kind === 'agent' &&
        typeof participant.agent_id === 'number' &&
        options.members.has(participant.agent_id),
    )
  const id = update.type === 'added' ? update.agent?.id : update.id
  const parent = update.type === 'added' ? update.agent?.parent : update.parent
  if (typeof id !== 'number') return false
  if (options.members.has(id)) return true
  if (!options.subtree || typeof parent !== 'number' || !options.members.has(parent)) return false
  options.members.add(id)
  return true
}

export declare namespace belongs {
  type Options = { members: Set<number>; subtree: boolean }
}

export function entries(updates: Iterable<Update>): Contracts.SubagentEntry[] {
  const found = new Map<number, Contracts.SubagentEntry>()
  for (const update of updates) {
    if (update.type === 'added' && typeof update.agent?.id === 'number') {
      const agent = update.agent
      const known = found.get(agent.id as number)
      found.set(agent.id as number, {
        agent_id: agent.id as number,
        can_manage: false,
        can_message: false,
        parent_agent_id: typeof agent.parent === 'number' ? agent.parent : null,
        reasoning_mode: agent.reasoning_mode === 'pro' ? 'pro' : 'standard',
        role: typeof agent.role === 'string' ? agent.role : '',
        status: known?.status ?? { state: 'running' },
        task: typeof agent.task === 'string' ? agent.task : '',
        ...(agent.model === undefined
          ? {}
          : { model: agent.model as Contracts.SubagentSummary['model'] }),
        ...(typeof agent.thinking === 'string'
          ? { thinking: agent.thinking as Contracts.Thinking }
          : {}),
      })
      continue
    }
    if (update.type !== 'status' && update.type !== 'completion') continue
    const entry = typeof update.id === 'number' ? found.get(update.id) : undefined
    if (!entry || entry.status.state === 'closed') continue
    entry.status = update.status as Contracts.SubagentStatus
  }
  return [...found.values()]
    .sort((left, right) => left.agent_id - right.agent_id)
    .map((entry) => ({
      ...entry,
      can_manage: entry.status.state !== 'closing' && entry.status.state !== 'closed',
      can_message:
        entry.status.state !== 'pending' &&
        entry.status.state !== 'closing' &&
        entry.status.state !== 'closed',
    }))
}

export function members(
  listed: readonly Contracts.SubagentEntry[],
  options: members.Options,
): Set<number> {
  const found = new Set([options.id])
  for (let grown = options.subtree; grown; ) {
    grown = false
    for (const entry of listed) {
      if (entry.parent_agent_id === null || found.has(entry.agent_id)) continue
      if (!found.has(entry.parent_agent_id)) continue
      found.add(entry.agent_id)
      grown = true
    }
  }
  return found
}

export declare namespace members {
  type Options = { id: number; subtree: boolean }
}

export function tree(
  listed: readonly Contracts.SubagentEntry[],
  options: tree.Options,
): number | undefined {
  const parents = new Map(listed.map((entry) => [entry.agent_id, entry.parent_agent_id]))
  let id = options.id
  for (let depth = 0; depth <= listed.length; depth++) {
    const parent = parents.get(id)
    if (parent === undefined) return undefined
    if (parent === null) return id
    id = parent
  }
  return undefined
}

export declare namespace tree {
  type Options = { id: number }
}

export function update(logged: Contracts.LoggedEvent): Update | undefined {
  const body = logged.event as { source?: unknown; update?: Update } | null | undefined
  return body?.source === 'subagent' ? body.update : undefined
}
