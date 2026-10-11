import { describe, expect, test } from 'bun:test'
import { decideOutboxLifecycle, OUTBOX_REJECTION_QUARANTINE_ATTEMPTS } from './outbox-lifecycle.ts'

describe('outbox lifecycle', () => {
  test.each(['applied', 'duplicate'] as const)('%s completes the entry', (kind) => {
    expect(decideOutboxLifecycle(0, { kind })).toEqual({ action: 'sent' })
  })

  test('rejection retries below the threshold and quarantines at it', () => {
    expect(decideOutboxLifecycle(0, { kind: 'rejected', reason: 'invalid' })).toEqual({
      action: 'retry',
      attempts: 1,
      lastError: 'invalid',
    })
    expect(
      decideOutboxLifecycle(OUTBOX_REJECTION_QUARANTINE_ATTEMPTS - 1, {
        kind: 'rejected',
        reason: 'invalid',
      }),
    ).toEqual({ action: 'quarantine', attempts: 3, lastError: 'invalid', reason: 'invalid' })
  })
})
