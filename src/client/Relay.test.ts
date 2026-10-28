/**
 * Integration suite for hand relay addresses, tokens, and connect commands.
 *
 * @module
 */
import { describe, expect, test } from 'vite-plus/test'
import * as Relay from './Relay.ts'

describe('commands', () => {
  test('returns the install and short commands', () => {
    const commands = Relay.commands({ token: 'abc', url: 'wss://example.com/hands' })

    expect(commands).toMatchInlineSnapshot(`
      {
        "command": "curl -fsSL https://nanocode.xyz/install | sh -s -- hand 'wss://example.com/hands' --token abc",
        "short": "nc hand 'wss://example.com/hands' --token abc",
      }
    `)
  })
})

describe('createToken', () => {
  test('returns 32 hexadecimal characters', () => {
    const token = Relay.createToken()

    expect(/^[0-9a-f]{32}$/.test(token)).toMatchInlineSnapshot(`true`)
  })
})

describe('socketUrl', () => {
  test('resolves a path against the base as a WebSocket URL', () => {
    expect(
      Relay.socketUrl('sessions/a/hands', { base: 'https://example.com/app/' }),
    ).toMatchInlineSnapshot(`"wss://example.com/app/sessions/a/hands"`)
    expect(Relay.socketUrl('/relay', { base: 'http://localhost:8787' })).toMatchInlineSnapshot(
      `"ws://localhost:8787/relay"`,
    )
  })
})
