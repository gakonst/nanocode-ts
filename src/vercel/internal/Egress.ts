import * as dns from 'node:dns'
import * as dnsPromises from 'node:dns/promises'
import { Agent, fetch as undiciFetch } from 'undici'
import * as Egress from '../../internal/Egress.ts'

type Callback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void

let agent: Agent | undefined

export function guard(fetcher?: typeof fetch): typeof fetch {
  return Egress.guard(fetcher ?? pinned, { resolve })
}

export const pinned: typeof fetch = (input, init) => {
  agent ??= new Agent({ connect: { lookup } as never })
  const url = input instanceof Request ? input.url : String(input)
  return undiciFetch(url, {
    ...(init as object),
    dispatcher: agent,
  } as never) as unknown as Promise<Response>
}

export const resolve: Egress.Resolve = async (host) =>
  (await dnsPromises.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)

function lookup(hostname: string, options: dns.LookupOptions, callback: Callback): void {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, '')

    const bad = addresses.find((entry) => !Egress.publicAddress(entry.address))
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
