import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from '../database/migrations.ts'
import {
  migratedTestDatabase,
  migrationBoundaryTestDatabase,
} from '../database/test-database.fixture.ts'
import { fileUnavailableMonitorIssues } from './monitor-issue-filing.ts'
import { pruneMonitorRows } from './monitor-retention.ts'
import { monitorReleasedBefore } from './monitor-retention-state.ts'
import { MONITOR_HISTORY_DEFAULT_LIMIT, type MonitorCondition } from './monitor-types.ts'

test('monitor prune preserves the newest history limit and issue-key reuse', async () => {
  const database = migratedTestDatabase()
  try {
    const invocations: string[] = []
    for (let index = 0; index <= MONITOR_HISTORY_DEFAULT_LIMIT; index += 1) {
      const recordId = newRecordId()
      invocations.push(recordId)
      database
        .query(
          `INSERT INTO monitor_invocation(record_id,started_at,trigger,findings,errors)
           VALUES (?,?, 'invoked',1,0)`,
        )
        .run(
          recordId,
          new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 1_000).toISOString(),
        )
    }
    database
      .query(
        `INSERT INTO monitor_condition
         (record_id,invocation_record_id,kind,subject,detail,action,issue_key)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        newRecordId(),
        invocations[0]!,
        'detector-unavailable',
        'fixture',
        'detail',
        'act',
        'DEV-1',
      )
    database
      .query(
        'INSERT INTO monitor_issue(record_id,kind,subject,issue_key,filed_at) VALUES (?,?,?,?,?)',
      )
      .run(newRecordId(), 'detector-unavailable', 'fixture', 'DEV-1', '2026-09-01T00:00:00.000Z')

    expect(pruneMonitorRows(database, { now: Date.parse('2026-10-01T00:00:00.000Z') })).toEqual({
      invocations: 1,
      conditions: 1,
      more: false,
    })
    expect(monitorReleasedBefore(database)).toBe('2026-09-01T00:00:00.000Z')
    expect(database.query('SELECT COUNT(*) count FROM monitor_invocation').get()).toEqual({
      count: MONITOR_HISTORY_DEFAULT_LIMIT,
    })
    const condition: MonitorCondition = {
      kind: 'detector-unavailable',
      subject: 'fixture',
      since: null,
      ageMs: null,
      detail: 'detail',
      action: 'act',
    }
    database
      .query(
        `INSERT INTO monitor_condition
         (record_id,invocation_record_id,kind,subject,detail,action)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(newRecordId(), invocations[1]!, condition.kind, condition.subject, 'detail', 'act')
    await fileUnavailableMonitorIssues(database, [condition], [], invocations[1]!, 2)
    expect(condition.issueKey).toBe('DEV-1')
    expect(
      database
        .query('SELECT issue_key FROM monitor_condition WHERE invocation_record_id=?')
        .get(invocations[1]!),
    ).toEqual({ issue_key: 'DEV-1' })
  } finally {
    database.close()
  }
})

test('telemetry migration backfills the newest filed issue per condition identity', () => {
  const database = migrationBoundaryTestDatabase('0204_telemetry_rollups')
  try {
    const olderInvocation = newRecordId()
    const newerInvocation = newRecordId()
    database
      .query('INSERT INTO monitor_invocation(record_id,started_at,trigger) VALUES (?,?,?)')
      .run(olderInvocation, '2026-09-01T00:00:00.000Z', 'invoked')
    database
      .query('INSERT INTO monitor_invocation(record_id,started_at,trigger) VALUES (?,?,?)')
      .run(newerInvocation, '2026-09-02T00:00:00.000Z', 'invoked')
    const insert = database.query(
      `INSERT INTO monitor_condition
       (record_id,invocation_record_id,kind,subject,detail,action,issue_key)
       VALUES (?,?,?,?,?,?,?)`,
    )
    insert.run(newRecordId(), olderInvocation, 'dead-lock', 'fixture', 'old', 'act', 'DEV-1')
    insert.run(newRecordId(), newerInvocation, 'dead-lock', 'fixture', 'new', 'act', 'DEV-2')

    applyMigrations(database)

    expect(
      database.query('SELECT kind,subject,issue_key,filed_at FROM monitor_issue').get(),
    ).toEqual({
      kind: 'dead-lock',
      subject: 'fixture',
      issue_key: 'DEV-2',
      filed_at: '2026-09-02T00:00:00.000Z',
    })
  } finally {
    database.close()
  }
})
