import { describe, expect, test } from 'bun:test'
import { decideGateOutcome, FAILED_STEP_DETAIL_LINES, type GateStepResult } from './check-outcome'

describe('gate outcome', () => {
  test('lists failed steps in the given order and exits 1', () => {
    expect(
      decideGateOutcome([
        { name: 'hub', exitCode: 1, detail: [], omittedDetailLines: 0 },
        { name: 'orchestrator', exitCode: 0, detail: [], omittedDetailLines: 0 },
        { name: 'check-architecture.ts', exitCode: 1, detail: [], omittedDetailLines: 0 },
        { name: 'check-file-ceiling.ts', exitCode: 0, detail: [], omittedDetailLines: 0 },
        { name: 'check-cognitive-ceiling.ts', exitCode: 2, detail: [], omittedDetailLines: 0 },
      ]),
    ).toEqual({
      failures: ['hub', 'check-architecture.ts', 'check-cognitive-ceiling.ts'],
      summary: ['hub', 'check-architecture.ts', 'check-cognitive-ceiling.ts'],
      exitCode: 1,
    })
  })

  test('exits 0 and lists nothing when every step passed', () => {
    expect(
      decideGateOutcome([
        { name: 'hub', exitCode: 0, detail: [], omittedDetailLines: 0 },
        { name: 'check-architecture.ts', exitCode: 0, detail: [], omittedDetailLines: 0 },
      ]),
    ).toEqual({ failures: [], summary: [], exitCode: 0 })
  })

  const detailCases: { name: string; steps: GateStepResult[]; summary: string[] }[] = [
    {
      name: 'prints a failed step detail under its name',
      steps: [
        {
          name: 'Biome',
          exitCode: 1,
          detail: ['src/x.ts:1 format differs'],
          omittedDetailLines: 0,
        },
      ],
      summary: ['Biome', '  src/x.ts:1 format differs'],
    },
    {
      name: 'caps failed step detail and reports the omitted count',
      steps: [
        {
          name: 'Biome',
          exitCode: 1,
          omittedDetailLines: 0,
          detail: Array.from(
            { length: FAILED_STEP_DETAIL_LINES + 2 },
            (_, index) => `line ${index}`,
          ),
        },
      ],
      summary: [
        'Biome',
        ...Array.from({ length: FAILED_STEP_DETAIL_LINES - 1 }, (_, index) => `  line ${index}`),
        '  … 3 more',
      ],
    },
    {
      name: 'reports earlier lines omitted by capture',
      steps: [{ name: 'root tests', exitCode: 1, detail: ['tail'], omittedDetailLines: 17 }],
      summary: ['root tests', '  … 17 earlier lines omitted', '  tail'],
    },
    {
      name: 'prints a note without taking space from full detail',
      steps: [
        {
          name: 'Biome',
          exitCode: 1,
          detail: Array.from({ length: FAILED_STEP_DETAIL_LINES }, (_, index) => `line ${index}`),
          omittedDetailLines: 0,
          note: 'Biome error list could not be read: invalid JSON',
        },
      ],
      summary: [
        'Biome',
        '  Biome error list could not be read: invalid JSON',
        ...Array.from({ length: FAILED_STEP_DETAIL_LINES }, (_, index) => `  line ${index}`),
      ],
    },
  ]

  for (const detailCase of detailCases) {
    test(detailCase.name, () => {
      expect(decideGateOutcome(detailCase.steps).summary).toEqual(detailCase.summary)
    })
  }
})
