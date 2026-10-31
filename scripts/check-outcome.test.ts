import { describe, expect, test } from 'bun:test'
import {
  biomeFindingDetails,
  decideGateOutcome,
  FAILED_STEP_SUMMARY_LINES,
  type GateStepResult,
} from './check-outcome'

describe('gate outcome', () => {
  test('lists failed steps in the given order and exits 1', () => {
    expect(
      decideGateOutcome([
        { name: 'hub', exitCode: 1, detail: [] },
        { name: 'orchestrator', exitCode: 0, detail: [] },
        { name: 'check-architecture.ts', exitCode: 1, detail: [] },
        { name: 'check-file-ceiling.ts', exitCode: 0, detail: [] },
        { name: 'check-cognitive-ceiling.ts', exitCode: 2, detail: [] },
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
        { name: 'hub', exitCode: 0, detail: [] },
        { name: 'check-architecture.ts', exitCode: 0, detail: [] },
      ]),
    ).toEqual({ failures: [], summary: [], exitCode: 0 })
  })

  const detailCases: { name: string; steps: GateStepResult[]; summary: string[] }[] = [
    {
      name: 'prints a failed step detail under its name',
      steps: [{ name: 'Biome', exitCode: 1, detail: ['src/x.ts:1 format differs'] }],
      summary: ['Biome', '  src/x.ts:1 format differs'],
    },
    {
      name: 'caps failed step detail and reports the omitted count',
      steps: [
        {
          name: 'Biome',
          exitCode: 1,
          detail: Array.from(
            { length: FAILED_STEP_SUMMARY_LINES + 2 },
            (_, index) => `line ${index}`,
          ),
        },
      ],
      summary: [
        'Biome',
        ...Array.from({ length: FAILED_STEP_SUMMARY_LINES - 1 }, (_, index) => `  line ${index}`),
        '  … 3 more',
      ],
    },
    {
      name: 'omits a passing step',
      steps: [{ name: 'Biome', exitCode: 0, detail: ['unused detail'] }],
      summary: [],
    },
    {
      name: 'prints only the name for empty failed step detail',
      steps: [{ name: 'Biome', exitCode: 1, detail: [] }],
      summary: ['Biome'],
    },
  ]

  for (const detailCase of detailCases) {
    test(detailCase.name, () => {
      expect(decideGateOutcome(detailCase.steps).summary).toEqual(detailCase.summary)
    })
  }
})

describe('Biome gate detail', () => {
  test('formats a finding as a single summary line', () => {
    expect(
      biomeFindingDetails([
        {
          file: 'src/x.ts',
          line: 1,
          rule: 'format',
          message: 'File content differs…',
        },
      ]),
    ).toEqual(['src/x.ts:1 format File content differs…'])
  })
})
