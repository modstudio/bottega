import { describe, expect, test } from 'bun:test'
import { proseGate } from './prose-gate.ts'

describe('proseGate', () => {
  test('names the field and refuses only introduced occurrences', async () => {
    const fresh = await proseGate([{ field: 'body', text: 'The meida stayed.', prior: null }], {
      displayName: null,
      enabled: true,
    })
    expect(fresh.refusal).toContain('body:\n"meida"')
    const existing = await proseGate(
      [{ field: 'body', text: 'The meida stayed.', prior: 'The meida stayed.' }],
      { displayName: null, enabled: true },
    )
    expect(existing.refusal).toBeNull()
  })

  test('switches off explicitly', async () => {
    expect(
      await proseGate([{ field: 'body', text: 'meida', prior: null }], {
        displayName: null,
        enabled: false,
      }),
    ).toEqual({ refusal: null, notices: ['Spelling and grammar check is switched off'] })
  })
})
