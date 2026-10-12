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

const sentReport = (): HostedOutboxReport => ({
  ...waitingReport(),
  sent: 1,
  waitingOnRouting: {},
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

  test('waits after no progress until a newer entry exists', () => {
    const lastDrain = { at: '2026-10-12T12:00:02.000Z', madeProgress: false }
    expect(
      shouldDrainHostedOutboxFast(
        { pendingCount: 1, newestQueuedAt: '2026-10-12T12:00:01.000Z' },
        lastDrain,
      ),
    ).toBeFalse()
    expect(
      shouldDrainHostedOutboxFast(
        { pendingCount: 2, newestQueuedAt: '2026-10-12T12:00:03.000Z' },
        lastDrain,
      ),
    ).toBeTrue()
  })
})

describe('fast hosted outbox collection', () => {
  test('an empty outbox never calls the drain', async () => {
    const drain = mock(async () => sentReport())
    const schedule = new HostedOutboxDrainSchedule(drain, () => '2026-10-12T12:00:00.000Z')

    expect(
      await collectFastHostedOutbox(schedule, {
        pending: () => ({ pendingCount: 0, newestQueuedAt: null }),
      }),
    ).toBeNull()
    expect(drain).not.toHaveBeenCalled()
  })

  test('a queued entry drains on the next fast cycle', async () => {
    const drain = mock(async () => sentReport())
    const schedule = new HostedOutboxDrainSchedule(drain, () => '2026-10-12T12:00:02.000Z')

    const result = await collectFastHostedOutbox(schedule, {
      pending: () => ({ pendingCount: 1, newestQueuedAt: '2026-10-12T12:00:01.000Z' }),
    })

    expect(result).toEqual({ source: 'hosted outbox', ok: true, hostedOutbox: sentReport() })
    expect(drain).toHaveBeenCalledTimes(1)
  })

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

    now = '2026-10-12T12:00:04.000Z'
    expect(
      await collectFastHostedOutbox(schedule, {
        pending: () => ({ pendingCount: 2, newestQueuedAt: '2026-10-12T12:00:03.000Z' }),
      }),
    ).not.toBeNull()
    expect(drain).toHaveBeenCalledTimes(3)
  })

  test('a drain failure is a failed leg rather than a rejected cycle', async () => {
    const schedule = new HostedOutboxDrainSchedule(
      async () => {
        throw new Error('hosted hub offline')
      },
      () => '2026-10-12T12:00:02.000Z',
    )

    await expect(
      collectFastHostedOutbox(schedule, {
        pending: () => ({ pendingCount: 1, newestQueuedAt: '2026-10-12T12:00:01.000Z' }),
      }),
    ).resolves.toEqual({ source: 'hosted outbox', ok: false, error: 'hosted hub offline' })
  })
})
