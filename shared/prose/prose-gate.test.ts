import { describe, expect, test } from 'bun:test'
import { proseGate } from './prose-gate.ts'

describe('proseGate', () => {
  test('names the field and refuses only introduced occurrences', async () => {
    const misspelling = ['me', 'ida'].join('')
    const sentence = `The ${misspelling} stayed.`
    const fresh = await proseGate([{ field: 'body', text: sentence, prior: null }], {
      displayName: null,
      enabled: true,
    })
    expect(fresh.refusal).toContain(`body:\n"${misspelling}"`)
    const existing = await proseGate([{ field: 'body', text: sentence, prior: sentence }], {
      displayName: null,
      enabled: true,
    })
    expect(existing.refusal).toBeNull()
  })

  test('switches off explicitly', async () => {
    expect(
      await proseGate([{ field: 'body', text: ['me', 'ida'].join(''), prior: null }], {
        displayName: null,
        enabled: false,
      }),
    ).toEqual({ refusal: null, notices: ['Spelling and grammar check is switched off'] })
  })

  test('reports an engine skip as a field notice without refusing', async () => {
    const result = await proseGate([{ field: 'summary', text: 'Text.', prior: null }], {
      displayName: null,
      enabled: true,
      engine: async () => ({ ran: false, reason: 'engine unavailable' }),
    })
    expect(result.refusal).toBeNull()
    expect(result.notices).toEqual([
      'summary: Spelling and grammar check did not run: engine unavailable',
    ])
  })
})
