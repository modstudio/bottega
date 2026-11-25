import { describe, expect, test } from 'bun:test'
import { BoundExceededError } from '../../../shared/call-budgets.ts'
import { RecordApiRequestError } from '../record/record-api-client-response.ts'
import {
  decideHostedReleaseRow,
  decideSessionCloseOutSweep,
  hostedReleaseFailure,
  hostedReleaseTripsCircuit,
} from './cleanup-sweep-session-close-out-decision.ts'

describe('closed session sweep decision', () => {
  const clean = {
    clean: true,
    closedAt: 100,
    lastSeenAt: null,
    sweptAt: null,
  }

  test.each([
    ['newest clean row', clean, { action: 'sweep' }],
    ['unclean row', { ...clean, clean: false }, { action: 'skip', reason: 'unclean' }],
    ['seen after close-out', { ...clean, lastSeenAt: 101 }, { action: 'skip', reason: 'resumed' }],
    ['already swept', { ...clean, sweptAt: 102 }, { action: 'skip', reason: 'already-swept' }],
  ] as const)('%s', (_name, facts, expected) => {
    expect(decideSessionCloseOutSweep(facts)).toEqual(expected)
  })
})

describe('hosted release failure decision', () => {
  test.each([
    [new RecordApiRequestError('bad request', 'refused', 400), 'final', false],
    [new RecordApiRequestError('destination refused', 'refused', 409), 'final', false],
    [new RecordApiRequestError('invalid', 'refused', 422), 'final', false],
    [new RecordApiRequestError('sign in', 'refused', 401), 'deferred-auth', true],
    [new RecordApiRequestError('forbidden', 'refused', 403), 'deferred-auth', true],
    [new RecordApiRequestError('not found', 'refused', 404), 'deferred', false],
    [new RecordApiRequestError('timeout', 'refused', 408), 'deferred', true],
    [new RecordApiRequestError('limited', 'refused', 429), 'deferred', true],
    [new RecordApiRequestError('server', 'server', 500), 'deferred', true],
    [new RecordApiRequestError('offline', 'unreachable'), 'deferred', true],
    [new BoundExceededError('record', 'hosted-close-out', 'deadline', 2_000), 'deferred', true],
  ] as const)('%s', (cause, failure, tripsCircuit) => {
    expect(hostedReleaseFailure(cause)).toBe(failure)
    expect(hostedReleaseTripsCircuit(cause)).toBe(tripsCircuit)
  })

  test('a final failure is stamped and keeps the route remedy', () => {
    expect(
      decideHostedReleaseRow({
        session: 'session-a',
        enabled: true,
        circuitCause: null,
        attempt: {
          outcome: 'failed',
          failure: 'final',
          message: 'operator session refused\npass the harness session id',
          tripCircuit: false,
        },
        platformSlug: 'bottega',
      }),
    ).toEqual({
      disposition: 'stamp-final',
      message:
        'hosted board claims of closed session session-a were not released: operator session refused\npass the harness session id; they are left to lapse',
      circuitCause: null,
    })
  })
})
