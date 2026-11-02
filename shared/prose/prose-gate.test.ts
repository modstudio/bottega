import { describe, expect, test } from 'bun:test'
import { proseGate } from './prose-gate.ts'

describe('proseGate', () => {
  test.each([
    ['recieve', 'receive'],
    ['seperate', 'separate'],
    ['mispelled', 'misspelled'],
    ['accidently', 'accidentally'],
    ['behaviour', 'behavior'],
    ['judgement', 'judgment'],
    ['licence', 'license'],
    ['modelled', 'modeled'],
    ['queueing', 'queuing'],
    ['Behaviour', 'Behavior'],
    ['sentense', 'sentence'],
    ["colour's", "color's"],
    ['colour’s', 'color’s'],
  ])('refuses %s and suggests %s', async (text, suggestion) => {
    const result = await proseGate([{ field: 'body', text, prior: null }], {
      displayName: null,
      enabled: true,
    })
    expect(result.refusal).toContain(`"${text}"; suggestion: "${suggestion}"`)
  })

  test.each([
    'catalogue',
    "catalogue's",
    'cancelled',
    'grey',
    'Lucene',
    'Postgres',
    'orch',
    'config',
    'failover',
    "don't",
    'analyse',
    'recognised',
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
  ])('does not refuse %s', async (text) => {
    const result = await proseGate([{ field: 'body', text, prior: null }], {
      displayName: null,
      enabled: true,
    })
    expect(result.refusal).toBeNull()
  })

  test.each(['Use `recieve` here.', '```\nrecieve\n```'])(
    'does not refuse corrections inside masked code',
    async (text) => {
      const result = await proseGate([{ field: 'body', text, prior: null }], {
        displayName: null,
        enabled: true,
      })
      expect(result.refusal).toBeNull()
    },
  )

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
    const sentence = 'The meida stayed.'
    const fresh = await proseGate([{ field: 'body', text: sentence, prior: null }], {
      displayName: null,
      enabled: true,
    })
    expect(fresh.refusal).toContain('body:\n"meida"')
    const existing = await proseGate([{ field: 'body', text: sentence, prior: sentence }], {
      displayName: null,
      enabled: true,
    })
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
