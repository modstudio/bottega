import { expect, test } from 'bun:test'
import {
  decideStopCloseOut,
  STOP_CLOSE_OUT_LEASE_WAIT_MS,
  waitForStopCloseOutLease,
} from './stop-close-out-decision.ts'

test('stop close-out runs when the lease is free or frees within the bound', () => {
  expect(decideStopCloseOut({ lease: 'free', coordinatorAlive: true, coordinatorPid: 42 })).toEqual(
    { action: 'run-close-out' },
  )
  expect(
    decideStopCloseOut({ lease: 'held-then-free', coordinatorAlive: true, coordinatorPid: 42 }),
  ).toEqual({ action: 'run-close-out' })
})

test('stop close-out leaves the tree when the lease is still held at the bound', () => {
  expect(
    decideStopCloseOut({ lease: 'still-held', coordinatorAlive: true, coordinatorPid: 42 }),
  ).toEqual({ action: 'leave-for-sweep', coordinatorPid: 42 })
  expect(
    decideStopCloseOut({ lease: 'still-held', coordinatorAlive: false, coordinatorPid: 42 }),
  ).toEqual({ action: 'leave-for-sweep', coordinatorPid: null })
})

test('waiting on the close-out lease reports free, held then free, or still held', () => {
  expect(
    waitForStopCloseOutLease('run-a', STOP_CLOSE_OUT_LEASE_WAIT_MS, {
      leaseHeld: () => false,
      now: () => 0,
      wait: () => {
        throw new Error('must not wait when the lease is already free')
      },
    }),
  ).toBe('free')

  let held = true
  let clock = 0
  expect(
    waitForStopCloseOutLease('run-b', STOP_CLOSE_OUT_LEASE_WAIT_MS, {
      leaseHeld: () => held,
      now: () => clock,
      wait: (ms) => {
        clock += ms
        held = false
      },
      pollMs: 50,
    }),
  ).toBe('held-then-free')

  clock = 0
  expect(
    waitForStopCloseOutLease('run-c', STOP_CLOSE_OUT_LEASE_WAIT_MS, {
      leaseHeld: () => true,
      now: () => clock,
      wait: (ms) => {
        clock += ms
      },
      pollMs: 10_000,
    }),
  ).toBe('still-held')
})
