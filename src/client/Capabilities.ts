import type * as Contracts from '../Contracts.ts'

export type Pack = {
  tools: {
    definitions: Contracts.HostTool[]
    call(name: string, input: unknown, signal: AbortSignal): Promise<unknown>
  }
  capabilities: Contracts.HandCapability[]
}

export type Name = 'location' | 'notifications' | 'clipboard'

type Entry = {
  capability: Contracts.HandCapability
  definitions: Contracts.HostTool[]
  call(name: string, input: Record<string, unknown>): Promise<unknown>
}

async function queried(name: string): Promise<Contracts.HandPermission | undefined> {
  const permissions = (globalThis.navigator as Navigator | undefined)?.permissions
  if (!permissions) return undefined
  try {
    const status = await permissions.query({ name } as PermissionDescriptor)
    return status.state
  } catch {
    return undefined
  }
}

function position(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject))
}

const object = { type: 'object', properties: {}, additionalProperties: false }

function location(): Entry {
  const permission = async () => (await queried('geolocation')) ?? 'prompt'
  return {
    capability: {
      name: 'location',
      description: "The user's approximate location from the browser",
      tools: ['location'],
      permission,
      request: async () => {
        try {
          await position()
          return 'granted'
        } catch {
          return (await queried('geolocation')) === 'granted' ? 'granted' : 'denied'
        }
      },
    },
    definitions: [
      {
        name: 'location',
        description:
          "Return the user's current location from their browser: latitude, longitude and accuracy in meters. The browser asks the user the first time.",
        parameters: object,
      },
    ],
    async call() {
      const { coords, timestamp } = await position()
      return {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy_m: coords.accuracy,
        at: new Date(timestamp).toISOString(),
      }
    },
  }
}

function notifications(): Entry {
  const current = (): Contracts.HandPermission => {
    const state = (globalThis as { Notification?: typeof Notification }).Notification?.permission
    return state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'prompt'
  }
  return {
    capability: {
      name: 'notifications',
      description: 'System notifications from the browser tab',
      tools: ['notify'],
      permission: current,
      request: async () => {
        const state = await Notification.requestPermission()
        return state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'prompt'
      },
    },
    definitions: [
      {
        name: 'notify',
        description:
          'Show the user a system notification from their browser, such as when long work finishes.',
        parameters: {
          type: 'object',
          properties: { title: { type: 'string' }, body: { type: 'string' } },
          required: ['title'],
          additionalProperties: false,
        },
      },
    ],
    async call(_, input) {
      if (current() !== 'granted')
        throw new Error('notifications are not allowed; request the capability first')
      new Notification(String(input.title), input.body ? { body: String(input.body) } : {})
      return { shown: true }
    },
  }
}

function clipboard(): Entry {
  return {
    capability: {
      name: 'clipboard',
      description: "Reading the user's clipboard; writing to it needs no permission",
      tools: ['clipboard_read'],
      permission: async () => (await queried('clipboard-read')) ?? 'prompt',
      request: async () => {
        try {
          await navigator.clipboard.readText()
          return 'granted'
        } catch {
          return (await queried('clipboard-read')) ?? 'denied'
        }
      },
    },
    definitions: [
      {
        name: 'clipboard_read',
        description: "Return the text on the user's clipboard.",
        parameters: object,
      },
      {
        name: 'clipboard_write',
        description: "Put text on the user's clipboard.",
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    ],
    async call(name, input) {
      if (name === 'clipboard_write') {
        await navigator.clipboard.writeText(String(input.text))
        return { written: true }
      }
      return { text: await navigator.clipboard.readText() }
    },
  }
}

const entries: Record<Name, () => Entry> = { location, notifications, clipboard }

export function browser(names: readonly Name[] = ['location', 'notifications', 'clipboard']): Pack {
  const supported = names.filter((name) =>
    name === 'location'
      ? typeof navigator !== 'undefined' && 'geolocation' in navigator
      : name === 'notifications'
        ? typeof Notification !== 'undefined'
        : typeof navigator !== 'undefined' && 'clipboard' in navigator,
  )
  const built = supported.map((name) => entries[name]())
  return pack(built)
}

function pack(built: Entry[]): Pack {
  const owners = new Map<string, Entry>()
  for (const entry of built)
    for (const definition of entry.definitions) owners.set(definition.name, entry)
  return {
    tools: {
      definitions: built.flatMap((entry) => entry.definitions),
      async call(name, input) {
        const entry = owners.get(name)
        if (!entry) throw new Error(`no browser tool named \`${name}\``)
        return entry.call(name, (input ?? {}) as Record<string, unknown>)
      },
    },
    capabilities: built.map((entry) => entry.capability),
  }
}

export function merge(...packs: Pack[]): Pack {
  const owners = new Map<string, Pack['tools']>()
  for (const { tools } of packs)
    for (const definition of tools.definitions) owners.set(definition.name, tools)
  return {
    tools: {
      definitions: packs.flatMap(({ tools }) => tools.definitions),
      call(name, input, signal) {
        const tools = owners.get(name)
        if (!tools) return Promise.reject(new Error(`no tool named \`${name}\``))
        return tools.call(name, input, signal)
      },
    },
    capabilities: packs.flatMap(({ capabilities }) => capabilities),
  }
}
