import { beforeEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { observeTrackerTask } from './ingest/trackers.ts'
import {
  discardHostedOutboxEntryCommand,
  drainHostedOutbox,
  hostedOutboxDoctorLines,
  hostedOutboxLines,
  listHostedOutbox,
  mergeQueuedHostedChange,
  queueHostedChange,
  retryHostedOutboxEntryCommand,
  showHostedOutboxEntry,
} from './outbox.ts'
import { listOutboxTrace } from './outbox-trace.ts'
import {
  HOSTED_COMMENT_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type HostedPushChange,
  type HostedPushOutcome,
} from './push-contract.ts'
import type { HostedTaskIdentity } from './task-client.ts'

const project = {
  name: 'fixture',
  path: '/fixture',
  repository: true,
  settings: { keyPrefixes: ['FIX'] },
}
const identity: HostedTaskIdentity = {
  userId: 'user-one',
  activeSpaceId: 'space-one',
  memberships: [{ spaceId: 'space-one', slug: 'one', permission: 'write' as const }],
  capabilities: {
    spacePush: true,
    spacePushTables: [
      HOSTED_TASK_TABLE,
      HOSTED_COMMENT_TABLE,
      HOSTED_DOCUMENT_TABLE,
      HOSTED_STATUS_EVENT_TABLE,
    ],
  },
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
  const event = observeTrackerTask(trackerTask(key, 'active'), at).event!.recordId
  writeTransaction((conn) =>
    conn.query(`DELETE FROM hosted_outbox WHERE table_name='hub_task'`).run(),
  )
  return event
}

beforeEach(resetFixtureStore)

describe('hosted outbox', () => {
  test('field-list merging preserves one-entry whole-row and delete semantics', () => {
    expect(
      mergeQueuedHostedChange(
        { operation: 'upsert', fields: ['title'] },
        { operation: 'upsert', fields: ['status'] },
      ),
    ).toEqual({ operation: 'upsert', fields: ['title', 'status'] })
    expect(
      mergeQueuedHostedChange(
        { operation: 'upsert', fields: ['title'] },
        { operation: 'upsert', fields: null },
      ),
    ).toEqual({ operation: 'upsert', fields: null })
    expect(
      mergeQueuedHostedChange(
        { operation: 'upsert', fields: null },
        { operation: 'upsert', fields: ['body'] },
      ),
    ).toEqual({ operation: 'upsert', fields: null })
    expect(
      mergeQueuedHostedChange(
        { operation: 'upsert', fields: ['body'] },
        { operation: 'delete', fields: ['title'] },
      ),
    ).toEqual({ operation: 'delete', fields: null })
    expect(
      mergeQueuedHostedChange(
        { operation: 'upsert', fields: [] },
        { operation: 'upsert', fields: ['title'] },
      ),
    ).toEqual({ operation: 'upsert', fields: ['title'] })
    expect(
      mergeQueuedHostedChange(
        { operation: 'upsert', fields: [] },
        { operation: 'upsert', fields: null },
      ),
    ).toEqual({ operation: 'upsert', fields: null })
  })

  test('show exposes kept values and discard removes only quarantined entries', () => {
    writeTransaction((conn) => {
      queueHostedChange(conn, HOSTED_TASK_TABLE, 'row-kept', 'upsert', undefined, ['title'])
      conn
        .query(
          `UPDATE hosted_outbox SET quarantined_at='2026-10-11T12:00:00.000Z',quarantine_reason='deleted',kept_values='{"title":"copy me"}' WHERE row_id='row-kept'`,
        )
        .run()
    })
    const id = listHostedOutbox()[0]!.id
    expect(showHostedOutboxEntry(id).join('\n')).toContain('copy me')
    expect(discardHostedOutboxEntryCommand(id)).toEqual([`outbox entry ${id} discarded`])
    expect(listHostedOutbox()).toHaveLength(0)
  })
  test('a tracker task queues only when its machine row changes', () => {
    observeTrackerTask(trackerTask('FIX-0', 'open'), '2026-10-11T11:00:00.000Z')
    expect(listHostedOutbox().map((entry) => entry.table_name)).toEqual([HOSTED_TASK_TABLE])
    writeTransaction((conn) => conn.exec(`DELETE FROM hosted_outbox`))
    observeTrackerTask(trackerTask('FIX-0', 'open'), '2026-10-11T11:01:00.000Z')
    expect(listHostedOutbox()).toHaveLength(0)
    observeTrackerTask(
      { ...trackerTask('FIX-0', 'open'), title: 'changed' },
      '2026-10-11T11:02:00.000Z',
    )
    expect(listHostedOutbox().map((entry) => entry.table_name)).toEqual([HOSTED_TASK_TABLE])
  })

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
      queueHostedChange(
        conn,
        HOSTED_STATUS_EVENT_TABLE,
        'row-one',
        'upsert',
        '2026-10-11T12:00:00.000Z',
      )
      queueHostedChange(
        conn,
        HOSTED_STATUS_EVENT_TABLE,
        'row-one',
        'upsert',
        '2026-10-11T12:01:00.000Z',
      )
    })
    expect(listHostedOutbox()).toHaveLength(1)
    expect(listHostedOutbox()[0]).toMatchObject({
      generation: 2,
      queued_at: '2026-10-11T12:01:00.000Z',
    })
  })

  test('upsert then delete sends only the delete and still delivers an unrelated entry', async () => {
    const replacedId = queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    const unrelatedId = queueTransition('FIX-2', '2026-10-11T12:01:00.000Z')
    writeTransaction((conn) =>
      queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, replacedId, 'delete'),
    )
    let sent: HostedPushChange[] = []
    await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push: async (changes) => {
        sent = changes
        return changes.map(({ id }) => ({ id, status: 'applied' as const }))
      },
    })
    expect(sent).toEqual(
      expect.arrayContaining([
        { table: HOSTED_STATUS_EVENT_TABLE, id: replacedId, op: 'delete' },
        expect.objectContaining({ id: unrelatedId, op: 'upsert' }),
      ]),
    )
    expect(sent).toHaveLength(2)
    expect(listHostedOutbox()).toHaveLength(0)
  })

  test('delete then upsert sends only the current row and still delivers an unrelated entry', async () => {
    const replacedId = queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    const unrelatedId = queueTransition('FIX-2', '2026-10-11T12:01:00.000Z')
    writeTransaction((conn) => {
      queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, replacedId, 'delete')
      queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, replacedId, 'upsert')
    })
    let sent: HostedPushChange[] = []
    await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push: async (changes) => {
        sent = changes
        return changes.map(({ id }) => ({ id, status: 'applied' as const }))
      },
    })
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: unrelatedId, op: 'upsert' }),
        expect.objectContaining({ id: replacedId, op: 'upsert' }),
      ]),
    )
    expect(sent).toHaveLength(2)
    expect(listHostedOutbox()).toHaveLength(0)
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
            ? ({
                id: change.id,
                status: 'rejected',
                reason: 'bad row',
              } as const)
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
    expect(listHostedOutbox()[0]).toMatchObject({
      attempts: 3,
      quarantine_reason: 'invalid',
    })
    const entryId = listHostedOutbox()[0]!.id
    expect(retryHostedOutboxEntryCommand(entryId)).toEqual([
      `outbox entry ${entryId} queued for retry`,
    ])
    expect(listHostedOutbox()[0]).toMatchObject({
      attempts: 3,
      quarantined_at: null,
    })
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
    expect(listHostedOutbox()[0]).toMatchObject({
      attempts: 0,
      last_error: null,
    })
    const report = await drainHostedOutbox({
      identity: async () => ({ ...identity, capabilities: {} }),
    })
    expect(report.skippedCapability).toBeTrue()
    expect(listHostedOutbox()[0]?.attempts).toBe(0)
  })

  test('two drains do not overlap and an expired outbox lease is taken over', async () => {
    const eventId = queueTransition('FIX-LOCK', '2026-10-11T12:00:00.000Z')
    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const first = drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      processKind: 'collector',
      push: async () => {
        firstStarted()
        await firstCanFinish
        return [{ id: eventId, status: 'applied' }]
      },
    })
    await firstDidStart
    let secondSends = 0
    const second = await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      processKind: 'command',
      push: async () => {
        secondSends++
        return [{ id: eventId, status: 'applied' }]
      },
    })
    expect(second).toMatchObject({ lockAcquired: false, queued: 1, sent: 0 })
    expect(secondSends).toBe(0)
    expect(listHostedOutbox()).toHaveLength(1)
    releaseFirst()
    await first

    const takeoverId = queueTransition('FIX-TAKEOVER', '2026-10-11T12:01:00.000Z')
    writeTransaction((conn) =>
      conn
        .query(`INSERT OR REPLACE INTO setting(key,value) VALUES ('hosted-outbox.lease',?)`)
        .run(JSON.stringify({ holder: 'crashed', until: 0 })),
    )
    const takeover = await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push: async () => [{ id: takeoverId, status: 'applied' }],
    })
    expect(takeover).toMatchObject({ sent: 1 })
    expect(takeover.lockAcquired).not.toBe(false)
  })

  test('a lease lost while a push is in flight traces delivery and leaves the generation queued', async () => {
    const eventId = queueTransition('FIX-LOST', '2026-10-11T12:00:00.000Z')
    const first = await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      processKind: 'collector',
      push: async () => {
        writeTransaction((conn) =>
          conn
            .query(`INSERT OR REPLACE INTO setting(key,value) VALUES ('hosted-outbox.lease',?)`)
            .run(
              JSON.stringify({
                holder: 'takeover',
                until: Date.now() + 60_000,
              }),
            ),
        )
        return [{ id: eventId, status: 'applied' }]
      },
    })
    expect(first).toMatchObject({ sent: 0 })
    expect(listHostedOutbox()[0]).toMatchObject({ generation: 1, attempts: 0 })
    expect(listOutboxTrace()).toEqual([
      expect.objectContaining({
        row_id: eventId,
        outcome: 'applied',
        reason: 'hosted outbox lease was lost after delivery',
        generation: 1,
      }),
    ])

    writeTransaction((conn) =>
      conn.query(`DELETE FROM setting WHERE key='hosted-outbox.lease'`).run(),
    )
    const later = await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push: async () => [{ id: eventId, status: 'duplicate' }],
    })
    expect(later.sent).toBe(1)
    expect(listHostedOutbox()).toHaveLength(0)
  })

  test('an older hosted hub sends supported task rows and waits on evidence tables', async () => {
    const eventId = queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    const intervalId = '01990000-0000-7000-8000-000000009001'
    const dayId = '01990000-0000-7000-8000-000000009002'
    writeTransaction((conn) => {
      conn
        .query(
          `INSERT INTO interval(record_id,project,source,start_at,end_at,ref)
          VALUES (?,'fixture','orch','2026-10-11T10:00:00.000Z',
            '2026-10-11T10:01:00.000Z','orch:9001')`,
        )
        .run(intervalId)
      conn
        .query(
          `INSERT INTO day(record_id,day,collected_at)
          VALUES (?,'2026-10-11','2026-10-11T23:00:00.000Z')`,
        )
        .run(dayId)
    })
    const sent: HostedPushChange[] = []
    const report = await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push: async (changes) => {
        sent.push(...changes)
        return changes.map(({ id }) => ({ id, status: 'applied' as const }))
      },
    })
    expect(sent.map((change) => change.id)).toEqual([eventId])
    expect(report.waitingOnHostedHub).toEqual({ hub_day: 1, hub_interval: 1 })
    expect(listHostedOutbox().map((entry) => [entry.table_name, entry.attempts])).toEqual([
      ['hub_interval', 0],
      ['hub_day', 0],
    ])
    expect(
      await hostedOutboxDoctorLines({
        identity: async () => identity,
        registered: () => [project],
      }),
    ).toEqual([
      'hosted outbox 1 waiting on hosted hub: hub_day',
      'hosted outbox 1 waiting on hosted hub: hub_interval',
    ])
  })

  test('an unroutable entry records its wait without attempts and clears it when routing resolves', async () => {
    queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    let registered: (typeof project)[] = []
    const waiting = await drainHostedOutbox({
      identity: async () => identity,
      registered: () => registered,
      push: async () => {
        throw new Error('must not push without routing')
      },
    })
    expect(waiting.waitingOnRouting).toEqual({ 'unregistered-project': 1 })
    expect(listHostedOutbox()[0]).toMatchObject({
      attempts: 0,
      last_error: `waiting on routing: project "fixture" is not registered; register it with ${PLATFORM_SLUG} project add <path>, or, if it is not a real project, note that such rows cannot be retired yet`,
    })
    expect(
      await hostedOutboxDoctorLines({
        identity: async () => identity,
        registered: () => [],
      }),
    ).toContain('hosted outbox 1 waiting on routing: unregistered-project')

    registered = [project]
    const delivered = await drainHostedOutbox({
      identity: async () => identity,
      registered: () => registered,
      push: async () => {
        throw new Error('offline after routing resolved')
      },
    })
    expect(delivered.sent).toBe(0)
    expect(listHostedOutbox()[0]).toMatchObject({ attempts: 0, last_error: null })
  })

  test('listing summarizes each blocked project with its count and oldest row', async () => {
    queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    queueTransition('FIX-2', '2026-10-11T12:01:00.000Z')
    await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [],
      push: async () => {
        throw new Error('must not push without routing')
      },
    })
    const lines = hostedOutboxLines()
    expect(lines[0]).toContain('project="fixture" rows=2 oldest=2026-10-11T12:00:00.000Z')
    expect(lines[0]).toContain(`register it with ${PLATFORM_SLUG} project add <path>`)
    expect(lines.slice(1)).toHaveLength(2)
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
      seen.push(
        changes[0]?.table === HOSTED_STATUS_EVENT_TABLE && changes[0].op === 'upsert'
          ? changes[0].row.from_status
          : null,
      )
      if (first) {
        first = false
        writeTransaction((conn) => {
          conn
            .query(`UPDATE task_status_event SET from_status='newer' WHERE record_id=?`)
            .run(eventId)
          queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, eventId, 'upsert')
        })
      }
      return [{ id: eventId, status: 'duplicate' as const }]
    }
    await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push,
    })
    expect(listHostedOutbox()[0]).toMatchObject({ generation: 2, attempts: 0 })
    await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push,
    })
    expect(seen).toEqual(['open', 'newer'])
    expect(listHostedOutbox()).toHaveLength(0)
    expect(listOutboxTrace().map((row) => row.generation)).toEqual([2, 1])
  })

  test('an acknowledgement for an old operation leaves the replacement queued', async () => {
    const eventId = queueTransition('FIX-1', '2026-10-11T12:00:00.000Z')
    writeTransaction((conn) =>
      queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, eventId, 'delete'),
    )
    let first = true
    const operations: Array<HostedPushChange['op']> = []
    const push = async (changes: HostedPushChange[]) => {
      operations.push(changes[0]!.op)
      if (first) {
        first = false
        writeTransaction((conn) =>
          queueHostedChange(conn, HOSTED_STATUS_EVENT_TABLE, eventId, 'upsert'),
        )
      }
      return [{ id: eventId, status: 'applied' as const }]
    }
    await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push,
    })
    expect(listHostedOutbox()[0]).toMatchObject({
      operation: 'upsert',
      generation: 3,
    })
    await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push,
    })
    expect(operations).toEqual(['delete', 'upsert'])
    expect(listHostedOutbox()).toHaveLength(0)
    expect(listOutboxTrace()).toEqual([
      expect.objectContaining({
        row_id: eventId,
        operation: 'delete',
        generation: 2,
      }),
    ])
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

  test('orders a parent task before its task children and status event', async () => {
    observeTrackerTask(trackerTask('FIX-10', 'open'), '2026-10-11T12:00:00.000Z')
    observeTrackerTask(trackerTask('FIX-11', 'open'), '2026-10-11T12:01:00.000Z')
    const parentId = db()
      .query<{ record_id: string }, []>(`SELECT record_id FROM task WHERE key='FIX-10'`)
      .get()!.record_id
    writeTransaction((conn) => {
      conn
        .query(`UPDATE task SET parent_key='FIX-10',parent_record_id=? WHERE key='FIX-11'`)
        .run(parentId)
      const child = conn
        .query<{ record_id: string }, []>(`SELECT record_id FROM task WHERE key='FIX-11'`)
        .get()!
      const commentId = Bun.randomUUIDv7()
      const documentId = Bun.randomUUIDv7()
      conn
        .query(
          `INSERT INTO task_comment
            (record_id,task_key,task_record_id,body,created_at)
            VALUES (?,'FIX-11',?,'comment','2026-10-11T12:01:00.000Z')`,
        )
        .run(commentId, child.record_id)
      conn
        .query(
          `INSERT INTO task_document
            (record_id,task_key,task_record_id,number,title,body,version,created_at,updated_at)
            VALUES (?,'FIX-11',?,1,'document','body','v1','2026-10-11T12:01:00.000Z','2026-10-11T12:01:00.000Z')`,
        )
        .run(documentId, child.record_id)
      queueHostedChange(conn, 'hub_task_comment', commentId, 'upsert')
      queueHostedChange(conn, 'hub_task_document', documentId, 'upsert')
    })
    observeTrackerTask(trackerTask('FIX-11', 'active'), '2026-10-11T12:02:00.000Z')
    const sent: HostedPushChange[] = []
    await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push: async (changes) => {
        sent.push(...changes)
        return changes.map(({ id }) => ({ id, status: 'applied' as const }))
      },
    })
    expect(sent.map((change) => change.table)).toEqual([
      HOSTED_TASK_TABLE,
      HOSTED_TASK_TABLE,
      HOSTED_COMMENT_TABLE,
      HOSTED_DOCUMENT_TABLE,
      HOSTED_STATUS_EVENT_TABLE,
    ])
    expect(
      sent
        .slice(0, 2)
        .map((change) =>
          change.table === HOSTED_TASK_TABLE && change.op === 'upsert' ? change.row.key : null,
        ),
    ).toEqual(['FIX-10', 'FIX-11'])
  })

  test('adopts the hosted task id in the transaction that completes its entry', async () => {
    observeTrackerTask(trackerTask('FIX-20', 'open'), '2026-10-11T12:00:00.000Z')
    const oldId = listHostedOutbox()[0]!.row_id
    const adoptedId = '01990000-0000-7000-8000-000000000020'
    const report = await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [project],
      push: async () => [{ id: oldId, status: 'applied', adoptedId }],
    })
    expect(report.sent).toBe(1)
    expect(
      db().query<{ record_id: string }, []>(`SELECT record_id FROM task WHERE key='FIX-20'`).get(),
    ).toEqual({ record_id: adoptedId })
    expect(listHostedOutbox()).toHaveLength(0)
  })
})
