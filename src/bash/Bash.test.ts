/**
 * Integration suite for the simulated shell, its file systems, and its command set.
 *
 * @module
 */
import { describe, expect, test } from 'vite-plus/test'
import * as Sqlite from '../../test/Sqlite.ts'
import {
  Bash,
  Command,
  FileSystem,
  GitHub,
  MemoryFileSystem,
  Mount,
  Python,
  SqlFileSystem,
} from './index.ts'

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

describe('Command', () => {
  test('runs a host command and reports its error status', async () => {
    const bash = await Bash.create({
      commands: {
        greet: (context) => {
          if (!context.args.length) throw new Command.CommandError('missing name', 2)
          context.stdout.write('hello ' + context.args.join(' ') + '\n')
        },
      },
    })

    expect(await bash.exec('greet ada | tr a-z A-Z')).toMatchInlineSnapshot(`
      {
        "exitCode": 0,
        "stderr": "",
        "stdout": "HELLO ADA
      ",
        "truncated": false,
      }
    `)
    expect(await bash.exec('greet; echo "status $?"')).toMatchInlineSnapshot(`
      {
        "exitCode": 0,
        "stderr": "greet: missing name
      ",
        "stdout": "status 2
      ",
        "truncated": false,
      }
    `)
  })
})

describe('FileSystem', () => {
  test('resolves paths and reports file errors', async () => {
    const fs = MemoryFileSystem.create()

    expect(FileSystem.resolvePath('/home/user', '../tmp/./notes//a.txt')).toMatchInlineSnapshot(
      `"/home/tmp/notes/a.txt"`,
    )
    await expect(fs.read('/missing.txt')).rejects.toThrowErrorMatchingInlineSnapshot(
      `[FileSystem.FsError: /missing.txt: No such file or directory]`,
    )
    expect(
      await fs.read('/missing.txt').catch((error: FileSystem.FsError) => error.name),
    ).toMatchInlineSnapshot(`"FileSystem.FsError"`)
  })
})

describe('GitHub', () => {
  test('builds archive URLs', () => {
    expect(
      GitHub.codeload({ owner: 'wevm', ref: 'release/v2', repo: 'viem' }),
    ).toMatchInlineSnapshot(`"https://codeload.github.com/wevm/viem/tar.gz/release/v2"`)
  })

  test('refuses hosts other than GitHub', async () => {
    const fetcher = GitHub.archives()

    await expect(fetcher('https://example.com/')).rejects.toThrowErrorMatchingInlineSnapshot(
      `[TypeError: GET https://example.com/ refused: this host reaches only public GitHub repositories (raw.githubusercontent.com files, codeload.github.com archives, github.com/OWNER/REPO/archive/, /releases/download/ and /raw/ files, and GET https://api.github.com/repos/OWNER/REPO with its /contents, /commits, /releases, /tarball and /zipball), so no other URL works from cells, curl or wget]`,
    )
  })
})

describe('Python', () => {
  test('returns the packages that a prompt mentions', () => {
    expect(Python.hint('Plot a chart of the pandas dataframe')).toMatchInlineSnapshot(`
      [
        "matplotlib",
        "pandas",
      ]
    `)
    expect(Python.hint('Count the lines in notes.txt')).toMatchInlineSnapshot(`undefined`)
  })
})
