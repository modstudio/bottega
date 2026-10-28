import { expect, test } from 'bun:test'
import { decideStopCloseOut } from './stop-close-out-decision.ts'

test('stop close-out runs when the lease is free or frees within the bound', () => {
  expect(decideStopCloseOut({ lease: 'free', coordinatorAlive: true, coordinatorPid: 42 })).toEqual(
    { action: 'run-close-out', extraPids: [42] },
  )
  expect(
    decideStopCloseOut({ lease: 'held-then-free', coordinatorAlive: true, coordinatorPid: 42 }),
  ).toEqual({ action: 'run-close-out', extraPids: [] })
})

test('stop close-out leaves the tree when the lease is still held at the bound', () => {
  expect(
    decideStopCloseOut({ lease: 'still-held', coordinatorAlive: true, coordinatorPid: 42 }),
  ).toEqual({ action: 'leave-for-sweep', coordinatorPid: 42 })
  expect(
    decideStopCloseOut({ lease: 'still-held', coordinatorAlive: false, coordinatorPid: 42 }),
  ).toEqual({ action: 'leave-for-sweep', coordinatorPid: null })
})
