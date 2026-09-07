import { expect, test } from 'bun:test'
import { HarnessHealthSchema } from './orch-contract.ts'

test('harness health has one validated cross-concern payload contract', () => {
  const payload = {
    header: 'never routing evidence', days: 1, from: '2026-09-07T00:00:00.000Z',
    classes: [{
      kind: 'timeout', count: 1, totalTimeMs: 1000, meanTimeMs: 1000,
      firstSeen: '2026-09-07T01:00:00.000Z', lastSeen: '2026-09-07T01:00:00.000Z',
      clusters: [{ text: 'timeout <n>', count: 1, exampleRunId: 7 }],
      sparkline: [{ day: '2026-09-07', count: 1 }],
    }],
    falseVerdicts: [{ kind: 'timeout', verdicts: 1, falseVerdicts: 0, rate: 0 }],
    landingRefusals: 0,
  }
  expect(HarnessHealthSchema.parse(payload)).toEqual(payload)
  expect(() => HarnessHealthSchema.parse({ ...payload, landingRefusals: '0' })).toThrow()
})
