/**
 * Integration suite for the model and thinking level rows of a chat's pickers.
 *
 * @module
 */
import { describe, expect, test } from 'vite-plus/test'
import * as Pickers from './Pickers.ts'

const harnesses: readonly Pickers.Harness[] = [
  {
    id: 'claude',
    label: 'Claude',
    models: [
      { effort: 'medium', efforts: ['low', 'medium', 'high'], id: 'sonnet', name: 'Sonnet' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    models: [{ effort: 'low', efforts: ['low', 'high'], id: 'luna', name: 'Luna' }],
  },
]

describe('models', () => {
  test('groups the matching models under their harness', () => {
    const items = Pickers.models(harnesses, { model: 'luna', query: '' })

    expect(items).toMatchInlineSnapshot(`
      [
        {
          "kind": "header",
          "label": "Claude",
        },
        {
          "current": false,
          "detail": "Sonnet · thinking low/medium/high",
          "kind": "choice",
          "label": "sonnet",
        },
        {
          "kind": "header",
          "label": "Codex",
        },
        {
          "current": true,
          "detail": "Luna · thinking low/high",
          "kind": "choice",
          "label": "luna",
        },
      ]
    `)
  })

  test('drops harnesses without a matching model', () => {
    const items = Pickers.models(harnesses, { model: 'luna', query: 'son high' })

    expect(items).toMatchInlineSnapshot(`
      [
        {
          "kind": "header",
          "label": "Claude",
        },
        {
          "current": false,
          "detail": "Sonnet · thinking low/medium/high",
          "kind": "choice",
          "label": "sonnet",
        },
      ]
    `)
  })
})

describe('thinking', () => {
  test('marks the chosen level', () => {
    const items = Pickers.thinking(harnesses[0]!.models[0], { thinking: 'high' })

    expect(items).toMatchInlineSnapshot(`
      [
        {
          "current": false,
          "detail": "",
          "kind": "choice",
          "label": "low",
        },
        {
          "current": false,
          "detail": "default",
          "kind": "choice",
          "label": "medium",
        },
        {
          "current": true,
          "detail": "",
          "kind": "choice",
          "label": "high",
        },
      ]
    `)
  })

  test('selects the default for a level that the model does not serve', () => {
    const items = Pickers.thinking(harnesses[1]!.models[0], { thinking: 'medium' })

    expect(items.find((item) => item.current)?.label).toMatchInlineSnapshot(`"low"`)
  })
})
