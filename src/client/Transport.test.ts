/**
 * Integration suite for the prompt text that a transport sends.
 *
 * @module
 */
import { describe, expect, test } from 'vite-plus/test'
import * as Transport from './Transport.ts'

describe('prompt', () => {
  test('appends one line for each attachment', () => {
    const attachments = [
      { name: 'a.png', path: '/workspace/uploads/a.png', size: 2048, type: 'image/png' },
      { name: 'b', path: '/workspace/uploads/b', size: 12, type: '' },
    ]

    expect(Transport.prompt('Describe these', { attachments })).toMatchInlineSnapshot(`
      "Describe these

      Attached: /workspace/uploads/a.png (image/png, 2 KB)
      Attached: /workspace/uploads/b (file, 12 B)"
    `)
    expect(Transport.prompt('', { attachments })).toMatchInlineSnapshot(`
      "Attached: /workspace/uploads/a.png (image/png, 2 KB)
      Attached: /workspace/uploads/b (file, 12 B)"
    `)
    expect(Transport.prompt('No files')).toMatchInlineSnapshot(`"No files"`)
  })
})
