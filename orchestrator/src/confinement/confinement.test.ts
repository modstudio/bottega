import { expect, test } from 'bun:test'
import { divergenceAttributionLabel, lockHolderObservationIsUnknown } from './confinement.ts'

test('a timed out or signal-killed lock-holder observation is unknown', () => {
  expect(
    lockHolderObservationIsUnknown({
      exitCode: null,
      signalCode: 'SIGTERM',
      exitedDueToTimeout: true,
    }),
  ).toBe(true)
  expect(
    lockHolderObservationIsUnknown({
      exitCode: null,
      signalCode: 'SIGKILL',
      exitedDueToTimeout: false,
    }),
  ).toBe(true)
  expect(
    lockHolderObservationIsUnknown({
      exitCode: 1,
      signalCode: null,
      exitedDueToTimeout: false,
    }),
  ).toBe(false)
})

test('an incomplete lock-holder observation is recorded in unattributed detail', () => {
  expect(
    divergenceAttributionLabel({
      attribution: 'unattributed',
      lockHolderObservation: 'unknown',
      lockHolder: null,
      landingSession: null,
    }),
  ).toBe('unattributed (lock holder unknown)')
})
