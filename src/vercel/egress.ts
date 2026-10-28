import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { Agent, fetch as undiciFetch } from 'undici'
import { guard, publicAddress, type Resolve } from '../egress.ts'

export const resolve: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)

type Callback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

function pinnedLookup(hostname: string, options: LookupOptions, callback: Callback): void {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, '')
    const bad = addresses.find((entry) => !publicAddress(entry.address))
    if (bad)
      return callback(
        Object.assign(
          new Error(
            'fetch refused: ' +
              hostname +
              ' resolves to ' +
              bad.address +
              ', which is not a public address',
          ),
          { code: 'ENOTPUBLIC' },
        ),
        '',
      )
    if (!addresses.length)
      return callback(
        Object.assign(new Error('fetch refused: ' + hostname + ' does not resolve'), {
          code: 'ENOTFOUND',
        }),
        '',
      )
    if (options.all) return callback(null, addresses)
    return callback(null, addresses[0]!.address, addresses[0]!.family)
  })
}

let agent: Agent | undefined

export const pinned: typeof fetch = (input, init) => {
  agent ??= new Agent({ connect: { lookup: pinnedLookup } as never })
  const url = input instanceof Request ? input.url : String(input)
  return undiciFetch(url, {
    ...(init as object),
    dispatcher: agent,
  } as never) as unknown as Promise<Response>
}

export function egress(fetcher?: typeof fetch): typeof fetch {
  return guard(fetcher ?? pinned, { resolve })
}
