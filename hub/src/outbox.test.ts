import { beforeEach, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { observeTrackerTask } from './ingest/trackers.ts'
import {
  drainHostedOutbox,
  hostedOutboxDoctorLines,
  listHostedOutbox,
  queueHostedChange,
  retryHostedOutboxEntry,
} from './outbox.ts'
import {
  type HostedPushChange,
  type HostedPushOutcome,
  PUSHABLE_HUB_CHANGE_TABLES,
} from './push-contract.ts'

const HOSTED_STATUS_EVENT_TABLE = PUSHABLE_HUB_CHANGE_TABLES[0]

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

  test('queuing the same operation twice advances one pointer generation', () => {
    writeTransaction((conn) => {
      queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, 'row-one', 'upsert')
      queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, 'row-one', 'upsert')
    })
    expect(listHostedOutbox()).toHaveLength(1)
    expect(listHostedOutbox()[0]?.generation).toBe(2)
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
    const reject = async (): Promise<HostedPushOutcome[]> => [
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

  test('an unroutable entry waits without attempts and delivers when routing resolves', async () => {
    const eventId = queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    let registered: (typeof project)[] = []
    const waiting = await drainHostedOutbox({
      identity: async () => identity,
      registered: () => registered,
      push: async () => {
        throw new Error('must not push without routing')
      },
    })
    expect(waiting.waitingOnRouting).toEqual({ 'unregistered-project': 1 })
    expect(listHostedOutbox()[0]).toMatchObject({ attempts: 0, last_error: null })
    expect(
      await hostedOutboxDoctorLines({ identity: async () => identity, registered: () => [] }),
    ).toContain('hosted outbox 1 waiting on routing: unregistered-project')

    registered = [project]
    const delivered = await drainHostedOutbox({
      identity: async () => identity,
      registered: () => registered,
      push: async () => [{ id: eventId, status: 'applied' }],
    })
    expect(delivered.sent).toBe(1)
    expect(listHostedOutbox()).toHaveLength(0)
  })

  test('drops an obsolete upsert whose current row is gone', async () => {
    writeTransaction((conn) =>
      queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, 'gone-row', 'upsert'),
    )
    const report = await drainHostedOutbox({ identity: async () => identity })
    expect(report).toMatchObject({ dropped: 1, rejected: 0, quarantined: 0 })
    expect(listHostedOutbox()).toHaveLength(0)
  })

  test('an acknowledgement completes only the generation that was sent', async () => {
    const eventId = queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    const seen: Array<string | null> = []
    let first = true
    const push = async (changes: HostedPushChange[]) => {
      seen.push(changes[0]?.op === 'upsert' ? changes[0].row.from_status : null)
      if (first) {
        first = false
        writeTransaction((conn) => {
          conn
            .query(`UPDATE task_status_event SET from_status='newer' WHERE record_id=?`)
            .run(eventId)
          queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, eventId, 'upsert')
        })
      }
      return [{ id: eventId, status: 'applied' as const }]
    }
    await drainHostedOutbox({ identity: async () => identity, registered: () => [project], push })
    expect(listHostedOutbox()[0]).toMatchObject({ generation: 2, attempts: 0 })
    await drainHostedOutbox({ identity: async () => identity, registered: () => [project], push })
    expect(seen).toEqual(['open', 'newer'])
    expect(listHostedOutbox()).toHaveLength(0)
  })

  test('routes a queued transition using the project declaration at drain time', async () => {
    const eventId = queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    const destinations: string[] = []
    await drainHostedOutbox({
      identity: async () => ({
        ...identity,
        memberships: [
          ...identity.memberships,
          { spaceId: 'space-two', slug: 'two', permission: 'write' as const },
        ],
      }),
      registered: () => [{ ...project, settings: { ...project.settings, space: 'two' } }],
      push: async (_changes, options) => {
        destinations.push(options.recordSpace)
        return [{ id: eventId, status: 'applied' }]
      },
    })
    expect(destinations).toEqual(['space-two'])
  })
})
