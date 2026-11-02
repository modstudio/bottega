import { describe, expect, test } from 'bun:test'
import { proseGate } from './prose-gate.ts'

describe('proseGate', () => {
  test.each([
    'triages',
    'Triages',
    'preapproved',
    'teardown',
    "teardown's",
    "routing's",
    'unmapped',
    'textless',
    'collectable',
    "DEV-1948's",
    "6262's",
    "step 2's",
    'The bug is at Lot.php:78 in the model.',
    'See LotAllocator.php:120-140 and grid.vue:12.',
  ])('does not refuse the real-word regression %s', async (text) => {
    const result = await proseGate([{ field: 'body', text, prior: null }], {
      displayName: null,
      enabled: true,
    })
    expect(result.refusal).toBeNull()
  })

  test.each(['sentense', 'mispelled', 'recieve', 'seperate'])(
    'refuses the typo %s',
    async (text) => {
      const result = await proseGate([{ field: 'body', text, prior: null }], {
        displayName: null,
        enabled: true,
      })
      expect(result.refusal).toContain(`"${text}"`)
    },
  )

  test.each([
    ['behaviour', 'behavior'],
    ['catalogue', 'catalog'],
    ['modelled', 'modeled'],
    ['judgement', 'judgment'],
    ['licence', 'license'],
  ])('refuses British %s and suggests %s', async (text, suggestion) => {
    const result = await proseGate([{ field: 'body', text, prior: null }], {
      displayName: null,
      enabled: true,
    })
    expect(result.refusal).toContain(`"${text}"; suggestion: "${suggestion}"`)
  })

  test('keeps the naming rule blocking', async () => {
    const result = await proseGate(
      [{ field: 'body', text: 'Operator approved it.', prior: null }],
      { displayName: null, enabled: true },
    )
    expect(result.refusal).toContain('Operator')
  })

  test('returns repeated words as an advisory notice without refusing', async () => {
    const result = await proseGate([{ field: 'body', text: 'the the', prior: null }], {
      displayName: null,
      enabled: true,
    })
    expect(result.refusal).toBeNull()
    expect(result.notices).toEqual(['body: advisory: "the the"; suggestion: "the"'])
  })

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

  test('does not refuse when the prior text could not be checked', async () => {
    const misspelling = ['me', 'ida'].join('')
    const current = `The ${misspelling} stayed.`
    const result = await proseGate([{ field: 'body', text: current, prior: misspelling }], {
      displayName: null,
      enabled: true,
      engine: async (text) =>
        text === misspelling
          ? { ran: false, reason: 'prior engine unavailable' }
          : {
              ran: true,
              findings: [
                {
                  rule: 'SpellCheck',
                  start: 4,
                  end: 9,
                  text: misspelling,
                  message: 'Did you mean media?',
                  suggestions: [{ kind: 'replace', text: 'media' }],
                },
              ],
            },
    })
    expect(result.refusal).toBeNull()
    expect(result.notices).toEqual([
      'body: Spelling and grammar check did not run: prior engine unavailable',
    ])
  })
})
