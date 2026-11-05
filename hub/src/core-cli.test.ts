import { expect, spyOn, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { CollectLegResult } from './collect.ts'
import { collectOneShot, runOneShotCollect } from './core-cli.ts'
import type { HostedOutboxReport } from './outbox.ts'

const result: CollectLegResult[] = [{ source: 'runs', ok: true, durationMs: 0 }]
const outboxReport: HostedOutboxReport = {
  queued: 1,
  sent: 1,
  rejected: 0,
  quarantined: 0,
  dropped: 0,
  waitingOnRouting: {},
  waitingOnHostedHub: {},
  skippedCapability: false,
}

test('one-shot collection selects incremental work unless a rebuild window is explicit', async () => {
  const calls: string[] = []
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    await collectOneShot(undefined, undefined, 'runs', {
      incremental: async (only) => {
        calls.push(`incremental:${only ?? ''}`)
        return result
      },
      rebuild: async () => {
        calls.push('rebuild')
        return result
      },
    })
    await collectOneShot(undefined, '2026-11-01T00:00:00.000Z', 'runs', {
      incremental: async () => {
        calls.push('incremental')
        return result
      },
      rebuild: async (since, only) => {
        calls.push(`rebuild:${since}:${only ?? ''}`)
        return result
      },
    })
  } finally {
    log.mockRestore()
  }
  expect(calls).toEqual(['incremental:runs', 'rebuild:2026-11-01T00:00:00.000Z:runs'])
})

test('a live watcher leaves collection alone without acquiring its lease and still drains outbox', async () => {
  const output: string[] = []
  const log = spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
  let outboxDrains = 0
  let leaseAttempts = 0
  try {
    await runOneShotCollect(
      {},
      {
        watcher: () => ({ holder: 'dashboard:42', ageSeconds: 3 }),
        outbox: async () => {
          outboxDrains++
          return { source: 'hosted outbox', ok: true, durationMs: 0, hostedOutbox: outboxReport }
        },
        lease: (async () => {
          leaseAttempts++
          throw new Error('collect lease must not be acquired')
        }) as never,
        collect: (async () => {
          throw new Error('collection legs must not run')
        }) as never,
      },
    )
  } finally {
    log.mockRestore()
  }
  expect(leaseAttempts).toBe(0)
  expect(outboxDrains).toBe(1)
  expect(output).toEqual([
    `hub collection: left to the live watcher (holder dashboard:42, heartbeat 3s ago); force with ${PLATFORM_SLUG} record pull --only <runs|transcripts|git|tasks>`,
    'hosted outbox     queued=1 sent=1 rejected=0 quarantined=0 dropped=0',
  ])
})

test('a stale watcher takes the existing leased collection path', async () => {
  let leaseAttempts = 0
  let collections = 0
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    await runOneShotCollect(
      {},
      {
        watcher: () => null,
        lease: (async (
          _holder: string,
          work: (guard: { assertHeld(): void }) => Promise<unknown>,
        ) => {
          leaseAttempts++
          return { ran: true, value: await work({ assertHeld() {} }) }
        }) as never,
        collect: (async () => {
          collections++
          return result
        }) as never,
      },
    )
  } finally {
    log.mockRestore()
  }
  expect(leaseAttempts).toBe(1)
  expect(collections).toBe(1)
})

test('--only tasks forces tracker collection despite a live watcher', async () => {
  const selected: string[] = []
  let watcherReads = 0
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    await runOneShotCollect(
      { only: 'tasks' },
      {
        watcher: () => {
          watcherReads++
          return { holder: 'dashboard:42', ageSeconds: 1 }
        },
        lease: (async (
          _holder: string,
          work: (guard: { assertHeld(): void }) => Promise<unknown>,
        ) => ({
          ran: true,
          value: await work({ assertHeld() {} }),
        })) as never,
        collect: ((
          guard: Parameters<typeof collectOneShot>[0],
          since: Parameters<typeof collectOneShot>[1],
          only: Parameters<typeof collectOneShot>[2],
        ) =>
          collectOneShot(guard, since, only, {
            incremental: async (selectedOnly) => {
              selected.push(selectedOnly ?? '')
              return [{ source: 'tasks', ok: true, durationMs: 0 }]
            },
          })) as never,
      },
    )
  } finally {
    log.mockRestore()
  }
  expect(watcherReads).toBe(0)
  expect(selected).toEqual(['tasks'])
})
