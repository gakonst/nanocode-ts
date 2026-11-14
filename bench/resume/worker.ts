import { env as bound } from 'cloudflare:workers'
import { App, Forward } from '../../src/cloudflare/index.ts'

type Env = App.Env & {
  ACCESS_TOKEN: string
  CELL_YIELD_MS?: string
  MODEL_URL: string
  SUBAGENTS?: string
  SUBSCRIPTION?: string
}

type Published = (scope: string, events: unknown[], bytes: number[]) => void

const account = 'harness'
const options = bound as Env

export const nanocode = App.create<Env>({
  authenticate: (request, env) =>
    request.headers.get('authorization') === 'Bearer ' + env.ACCESS_TOKEN ? account : null,
  ...(options.CELL_YIELD_MS ? { cellYieldMs: Number(options.CELL_YIELD_MS) } : {}),
  egress: (env) =>
    Forward.create({
      fetch: async (request) => {
        const source = new URL(request.url)
        const target = env.MODEL_URL.replace(/\/+$/, '') + source.pathname + source.search
        return fetch(
          new Request(target, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: request.signal,
          }),
        )
      },
    }),
  hands: 'always',
  ...(options.SUBAGENTS === undefined ? {} : { subagents: options.SUBAGENTS === 'true' }),
  ...(options.SUBSCRIPTION === 'true' ? { subscription: () => true } : {}),
  workspace: false,
})

const hosted = nanocode.AgentSession
const publish = (hosted.prototype as unknown as { published: Published }).published

export class AgentSession extends hosted {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS harness_published (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, body TEXT NOT NULL)',
    )
  }

  published(scope: string, events: unknown[], bytes: number[]): void {
    for (const event of events)
      this.sql.exec(
        'INSERT INTO harness_published (scope, body) VALUES (?, ?)',
        scope,
        JSON.stringify(event),
      )
    publish.call(this, scope, events, bytes)
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.has('x-harness-published'))
      return Response.json(
        this.sql
          .exec('SELECT scope, body FROM harness_published ORDER BY id')
          .toArray()
          .map((row) => ({ event: JSON.parse(String(row['body'])), scope: row['scope'] })),
      )
    return super.fetch(request)
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true })
    return nanocode.fetch(request, env)
  },
} satisfies ExportedHandler<Env>
