import { beforeEach, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { observeTrackerTask } from './ingest/trackers.ts'
import {
  drainHostedOutbox,
  HOSTED_STATUS_EVENT_TABLE,
  listHostedOutbox,
  type PushOutcome,
  queueHostedChange,
  retryHostedOutboxEntry,
} from './outbox.ts'

const project = {
  name: 'fixture',
  path: '/fixture',
  repository: true,
  settings: { keyPrefixes: ['FIX'] },
}
const identity = {
  userId: 'user-one',
  activeSpaceId: 'space-one',
  memberships: [{ spaceId: 'space-one', slug: 'one', permission: 'write' as const }],
  capabilities: { spacePush: true },
}
const trackerTask = (key: string, category: 'open' | 'active') => ({
  externalId: `tracker-${key}`,
  key,
  project: 'fixture',
  title: key,
  status: category,
  category,
  updatedAt: null,
  assignee: null,
})

function queueTransition(key: string, at: string) {
  observeTrackerTask(trackerTask(key, 'open'), at)
  return observeTrackerTask(trackerTask(key, 'active'), at).event!.recordId
}

beforeEach(resetFixtureStore)

describe('hosted outbox', () => {
  test('the status event and pointer commit and roll back together', () => {
    const committed = queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    expect(listHostedOutbox().map((entry) => entry.row_id)).toEqual([committed])

    observeTrackerTask(trackerTask('FIX-2', 'open'), '2026-10-11T12:01:00.000Z')
    writeTransaction((conn) =>
      conn.exec(`CREATE TEMP TRIGGER refuse_outbox BEFORE INSERT ON hosted_outbox
        BEGIN SELECT RAISE(ABORT,'refuse outbox'); END`),
    )
    expect(() =>
      observeTrackerTask(trackerTask('FIX-2', 'active'), '2026-10-11T12:02:00.000Z'),
    ).toThrow('refuse outbox')
    expect(
      db()
        .query<{ count: number }, []>(
          `SELECT count(*) count FROM task_status_event WHERE task_key='FIX-2'`,
        )
        .get()!.count,
    ).toBe(0)
    writeTransaction((conn) => conn.exec('DROP TRIGGER refuse_outbox'))
  })

  test('queuing the same operation twice keeps one unsent pointer', () => {
    writeTransaction((conn) => {
      queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, 'row-one', 'upsert')
      queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, 'row-one', 'upsert')
    })
    expect(listHostedOutbox()).toHaveLength(1)
  })

  test('sends current state, accepts success, and continues after rejection', async () => {
    const rejectedId = queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    const appliedId = queueTransition('FIX-2', '2026-10-11T12:01:00.000Z')
    writeTransaction((conn) =>
      conn
        .query(`UPDATE task_status_event SET from_status='current' WHERE record_id=?`)
        .run(appliedId),
    )
    const seen: Array<Record<string, unknown>> = []
    const report = await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push: async (changes) => {
        seen.push(...(changes as Array<{ row: Record<string, unknown> }>).map((row) => row.row))
        return changes.map((change: { id: string }) =>
          change.id === rejectedId
            ? ({ id: change.id, status: 'rejected', reason: 'bad row' } as const)
            : ({ id: change.id, status: 'applied' } as const),
        )
      },
    })
    expect(report).toMatchObject({ sent: 1, rejected: 1 })
    expect(seen.find((row) => row.id === appliedId)?.from_status).toBe('current')
    expect(listHostedOutbox().find((entry) => entry.row_id === rejectedId)?.attempts).toBe(1)
    expect(listHostedOutbox().some((entry) => entry.row_id === appliedId)).toBe(false)
  })

  test('duplicate marks sent and repeated rejection quarantines', async () => {
    const duplicateId = queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push: async () => [{ id: duplicateId, status: 'duplicate' }],
    })
    expect(listHostedOutbox()).toHaveLength(0)

    const rejectedId = queueTransition('FIX-2', '2026-10-11T12:01:00.000Z')
    const reject = async (): Promise<PushOutcome[]> => [
      { id: rejectedId, status: 'rejected', reason: 'invalid' },
    ]
    for (let pass = 0; pass < 3; pass++)
      await drainHostedOutbox({
        identity: async () => identity,
        registered: () => [project],
        push: reject,
      })
    expect(listHostedOutbox()[0]).toMatchObject({ attempts: 3, quarantine_reason: 'invalid' })
    const entryId = listHostedOutbox()[0]!.id
    expect(retryHostedOutboxEntry(entryId)).toBeTrue()
    expect(listHostedOutbox()[0]).toMatchObject({ attempts: 3, quarantined_at: null })
  })

  test('request failure and absent capability leave the entry untouched', async () => {
    queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push: async () => {
        throw new Error('offline')
      },
    })
    expect(listHostedOutbox()[0]).toMatchObject({ attempts: 0, last_error: null })
    const report = await drainHostedOutbox({
      identity: async () => ({ ...identity, capabilities: {} }),
    })
    expect(report.skippedCapability).toBeTrue()
    expect(listHostedOutbox()[0]?.attempts).toBe(0)
  })
})
