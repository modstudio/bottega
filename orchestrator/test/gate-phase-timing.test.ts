import { expect, test } from 'bun:test'
import { slowTestPhaseReport } from './gate-phase-timing.ts'

test('reports the phase split only when fixture work is slow', () => {
  expect(
    slowTestPhaseReport({
      file: 'src/gate/gate-decision.test.ts',
      name: 'broker execution finalizes',
      setupMs: 750,
      teardownMs: 251,
    }),
  ).toBe(
    'src/gate/gate-decision.test.ts: broker execution finalizes fixture phases 1001ms (setup 750ms, teardown 251ms) exceed reporting threshold 1000ms',
  )
  expect(
    slowTestPhaseReport({
      file: 'src/gate/gate-decision.test.ts',
      name: 'broker execution finalizes',
      setupMs: 20,
      teardownMs: 10,
    }),
  ).toBeNull()
})
