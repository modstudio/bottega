import { describe, expect, mock, test } from 'bun:test'
import { collectFastHostedOutbox } from './collect.ts'
import type { HostedOutboxReport } from './outbox.ts'
import { HostedOutboxDrainSchedule, shouldDrainHostedOutboxFast } from './outbox-fast-cycle.ts'

const waitingReport = (): HostedOutboxReport => ({
  queued: 1,
  sent: 0,
  rejected: 0,
  quarantined: 0,
  dropped: 0,
  waitingOnRouting: { 'unregistered-project': 1 },
  skippedCapability: false,
})

describe('fast hosted outbox decision', () => {
  test('requires pending work', () => {
    expect(
      shouldDrainHostedOutboxFast(
        { pendingCount: 0, newestQueuedAt: null },
        { at: '2026-10-12T12:00:00.000Z', madeProgress: true },
      ),
    ).toBeFalse()
  })

  test('runs for fresh work and after progress', () => {
    const pending = { pendingCount: 1, newestQueuedAt: '2026-10-12T12:00:01.000Z' }
    expect(shouldDrainHostedOutboxFast(pending, null)).toBeTrue()
    expect(
      shouldDrainHostedOutboxFast(pending, {
        at: '2026-10-12T12:00:00.000Z',
        madeProgress: true,
      }),
    ).toBeTrue()
  })

  test('waits after no progress until an entry queued at or after the drain exists', () => {
    const lastDrain = { at: '2026-10-12T12:00:02.000Z', madeProgress: false }
    expect(
      shouldDrainHostedOutboxFast(
        { pendingCount: 1, newestQueuedAt: '2026-10-12T12:00:01.000Z' },
        lastDrain,
      ),
    ).toBeFalse()
    expect(
      shouldDrainHostedOutboxFast(
        { pendingCount: 2, newestQueuedAt: '2026-10-12T12:00:02.000Z' },
        lastDrain,
      ),
    ).toBeTrue()
  })
})

describe('fast hosted outbox collection', () => {
  test('waiting work pauses fast drains until new work while slow drains unconditionally', async () => {
    let now = '2026-10-12T12:00:02.000Z'
    const drain = mock(async () => waitingReport())
    const schedule = new HostedOutboxDrainSchedule(drain, () => now)
    const oldPending = () => ({
      pendingCount: 1,
      newestQueuedAt: '2026-10-12T12:00:01.000Z',
    })

    expect(await collectFastHostedOutbox(schedule, { pending: oldPending })).not.toBeNull()
    expect(await collectFastHostedOutbox(schedule, { pending: oldPending })).toBeNull()
    expect(drain).toHaveBeenCalledTimes(1)

    await schedule.slow()
    expect(drain).toHaveBeenCalledTimes(2)
    expect(await collectFastHostedOutbox(schedule, { pending: oldPending })).toBeNull()

    const newPending = () => ({
      pendingCount: 2,
      newestQueuedAt: '2026-10-12T12:00:02.000Z',
    })
    now = '2026-10-12T12:00:03.000Z'
    expect(
      await collectFastHostedOutbox(schedule, {
        pending: newPending,
      }),
    ).not.toBeNull()
    expect(drain).toHaveBeenCalledTimes(3)
    expect(await collectFastHostedOutbox(schedule, { pending: newPending })).toBeNull()
    expect(drain).toHaveBeenCalledTimes(3)
  })
})
