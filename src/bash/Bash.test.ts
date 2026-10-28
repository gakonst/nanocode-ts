/**
 * Integration suite for the simulated shell, its file systems, and its command set.
 *
 * @module
 */
import { describe, expect, test } from 'vite-plus/test'
import * as Sqlite from '../../test/Sqlite.ts'
import { Bash, MemoryFileSystem, Mount, SqlFileSystem } from './index.ts'

describe('create', () => {
  test('runs pipelines, loops, and expansions', async () => {
    const bash = await Bash.create()

    const result = await bash.exec(
      'name=world; for i in 3 1 2; do echo "$i $name"; done | sort | tr "\\n" ","; echo; echo $((6 * 7))',
    )

    expect(result).toMatchInlineSnapshot(`
      {
        "exitCode": 0,
        "stderr": "",
        "stdout": "1 world,2 world,3 world,
      42
      ",
        "truncated": false,
      }
    `)
  })

  test('reads and writes files', async () => {
    const bash = await Bash.create({ files: { '/home/user/notes.txt': 'alpha\nbravo\ncharlie\n' } })

    const result = await bash.exec(
      'grep -n a notes.txt | wc -l; mkdir -p out && sed "s/bravo/delta/" notes.txt > out/edited.txt; cat out/edited.txt; find . -type f | sort',
    )

    expect(result).toMatchInlineSnapshot(`
      {
        "exitCode": 0,
        "stderr": "",
        "stdout": "3
      alpha
      delta
      charlie
      ./notes.txt
      ./out/edited.txt
      ",
        "truncated": false,
      }
    `)
    expect(await bash.readFile('out/edited.txt')).toMatchInlineSnapshot(`
      "alpha
      delta
      charlie
      "
    `)
  })

  test('runs awk and jq', async () => {
    const bash = await Bash.create()

    const result = await bash.exec(
      `printf 'a 1\\nb 2\\nc 3\\n' | awk '{ s += $2 } END { print s }'; echo '{"items":[{"n":1},{"n":2}]}' | jq -c '[.items[].n * 10]'`,
    )

    expect(result).toMatchInlineSnapshot(`
      {
        "exitCode": 0,
        "stderr": "",
        "stdout": "6
      [10,20]
      ",
        "truncated": false,
      }
    `)
  })

  test('reports a missing command', async () => {
    const bash = await Bash.create()

    expect(await bash.exec('nonexistent --flag')).toMatchInlineSnapshot(`
      {
        "exitCode": 127,
        "stderr": "bash: nonexistent: command not found
      ",
        "stdout": "",
        "truncated": false,
      }
    `)
  })

  test('reports a syntax error', async () => {
    const bash = await Bash.create()

    expect(await bash.exec('if true; then echo')).toMatchInlineSnapshot(`
      {
        "exitCode": 2,
        "stderr": "bash: syntax error: unexpected end of file
      ",
        "stdout": "",
        "truncated": false,
      }
    `)
  })

  test('emits started and finished events', async () => {
    const events: unknown[] = []
    const bash = await Bash.create({
      observe: (event) => {
        const { durationMs: _, ...rest } = event as { durationMs?: number }
        events.push(rest)
      },
    })

    await bash.exec('echo hi')
    await bash.exec('false')

    expect(events).toMatchInlineSnapshot(`
      [
        {
          "call": 1,
          "command": "echo",
          "phase": "started",
        },
        {
          "call": 1,
          "category": "none",
          "command": "echo",
          "exitCode": 0,
          "outputTruncated": false,
          "phase": "finished",
          "status": "success",
        },
        {
          "call": 2,
          "command": "false",
          "phase": "started",
        },
        {
          "call": 2,
          "category": "command_exit",
          "command": "false",
          "exitCode": 1,
          "outputTruncated": false,
          "phase": "finished",
          "status": "error",
        },
      ]
    `)
  })

  test('serves mounted file systems', async () => {
    const archive = MemoryFileSystem.create({ files: { '/report.txt': 'archived\n' } })
    const bash = await Bash.create({
      fs: Mount.create(MemoryFileSystem.create(), { mounts: { '/archive': archive } }),
    })

    expect(await bash.exec('cat /archive/report.txt; ls /archive')).toMatchInlineSnapshot(`
      {
        "exitCode": 0,
        "stderr": "",
        "stdout": "archived
      report.txt
      ",
        "truncated": false,
      }
    `)
  })
})

describe('SqlFileSystem', () => {
  test('keeps files across shells on one SQL host', async () => {
    const store = Sqlite.open()

    const first = await Bash.create({ fs: SqlFileSystem.create(store.sql, { scope: 'session' }) })
    await first.exec('mkdir -p /work && echo persisted > /work/state.txt')

    const second = await Bash.create({ fs: SqlFileSystem.create(store.sql, { scope: 'session' }) })
    const other = await Bash.create({ fs: SqlFileSystem.create(store.sql, { scope: 'other' }) })

    expect(await second.exec('cat /work/state.txt')).toMatchInlineSnapshot(`
      {
        "exitCode": 0,
        "stderr": "",
        "stdout": "persisted
      ",
        "truncated": false,
      }
    `)
    expect(await other.exec('cat /work/state.txt')).toMatchInlineSnapshot(`
      {
        "exitCode": 1,
        "stderr": "cat: /work/state.txt: No such file or directory
      ",
        "stdout": "",
        "truncated": false,
      }
    `)

    store.close()
  })
})
