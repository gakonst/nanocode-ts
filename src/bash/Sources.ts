import * as GitHub from './GitHub.ts'
import { TarReader } from './internal/commands/archive.ts'

export type Sources = {
  prime(source: string, data: Uint8Array): void
  read(source: string, size: number): Promise<Uint8Array>
}

type Archive = {
  bytes: number
  files: Map<string, Uint8Array>
  loading?: Promise<void> | undefined
  used: number
}

const archives = new Map<string, Archive>()

const pattern = /^github:([^/@]+)\/([^/@]+)@([0-9a-f]{40})\/(.+)$/

export function github(owner: string, repo: string, commit: string, path: string): string {
  return 'github:' + owner + '/' + repo + '@' + commit + '/' + path
}

export function create(options: create.Options = {}): Sources {
  const maxBytes = options.maxBytes ?? GitHub.maxBytes
  const fetcher = GitHub.wrap(options.fetch ?? globalThis.fetch.bind(globalThis), {
    token: options.token,
  })

  const parse = (source: string) => {
    const match = pattern.exec(source)
    if (!match) throw new Error('this filesystem cannot read the contents at ' + source)
    const [, owner, repo, commit, path] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ]
    return { commit, key: owner + '/' + repo + '@' + commit, owner, path, repo }
  }

  const archiveOf = (key: string): Archive => {
    const found: Archive = archives.get(key) ?? { bytes: 0, files: new Map(), used: 0 }
    found.used = Date.now()
    archives.set(key, found)
    return found
  }

  const keep = (archive: Archive, path: string, data: Uint8Array) => {
    archive.bytes += data.length - (archive.files.get(path)?.length ?? 0)
    archive.files.set(path, data)
  }

  const evict = (kept: string) => {
    let total = 0
    for (const archive of archives.values()) total += archive.bytes
    for (const [key, archive] of [...archives].sort((a, b) => a[1].used - b[1].used)) {
      if (total <= maxBytes) break
      if (key === kept) continue
      archives.delete(key)
      total -= archive.bytes
    }
  }

  const download = async (archive: Archive, owner: string, repo: string, commit: string) => {
    const url = options.archive
      ? options.archive(owner, repo, commit)
      : GitHub.codeload({ owner, ref: commit, repo })
    const response = await fetcher(url, { redirect: 'follow' })
    if (!response.ok || !response.body)
      throw new Error('downloading ' + url + ' answered HTTP ' + response.status)

    const reader = new TarReader(options.maxFileBytes ?? GitHub.maxFileBytes)
    const stream = response.body.pipeThrough(new DecompressionStream('gzip')).getReader()
    for (;;) {
      const next = await stream.read()
      if (next.done) break
      for (const entry of reader.push(next.value))
        if (entry.type === 'file' && entry.omitted === undefined)
          keep(archive, entry.name.split('/').slice(1).join('/'), entry.data)
      if (reader.done) break
    }
    await stream.cancel().catch(() => {})
  }

  return {
    prime(source, data) {
      const { key, path } = parse(source)
      keep(archiveOf(key), path, data)
      evict(key)
    },

    async read(source, size) {
      const { commit, key, owner, path, repo } = parse(source)
      const archive = archiveOf(key)
      if (!archive.files.has(path)) {
        archive.loading ??= download(archive, owner, repo, commit).finally(() => {
          archive.loading = undefined
        })
        await archive.loading
        evict(key)
      }

      const data = archive.files.get(path)
      if (!data)
        throw new Error(owner + '/' + repo + ' at ' + commit + ' has no ' + path + ' to read')
      if (data.length !== size)
        throw new Error(
          path +
            ' in ' +
            key +
            ' holds ' +
            data.length +
            ' bytes, not the ' +
            size +
            ' it was cloned with',
        )
      return data
    },
  }
}

export declare namespace create {
  type Options = {
    archive?: ((owner: string, repo: string, ref: string) => string) | undefined
    fetch?: typeof fetch | undefined
    maxBytes?: number | undefined
    maxFileBytes?: number | undefined
    token?: GitHub.Token | undefined
  }
}
