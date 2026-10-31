import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { displayConditions, formatMonitorPass, monitorHistory } from './monitor.ts'
import { MONITOR_DETAIL_CHARS } from './monitor-types.ts'

describe('operational monitor reports', () => {
  test('marks historical human output partial when that pass had an observation error', () => {
    const invocation = db()
      .query(
        `INSERT INTO monitor_invocation (record_id,started_at,finished_at,trigger,findings,errors)
       VALUES (?,'2026-09-04T00:00:00Z','2026-09-04T00:00:01Z','backstop',1,1)
       RETURNING record_id,number`,
      )
      .get(newRecordId()) as { record_id: string; number: number }
    db()
      .query(
        `INSERT INTO monitor_condition
       (record_id,invocation_record_id,kind,subject,condition_since,age_ms,detail,action)
       VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        newRecordId(),
        invocation.record_id,
        'observation-error',
        `invocation:${invocation.number}:1`,
        '2026-09-04T00:00:00Z',
        0,
        'docker inventory unavailable',
        'reported; no state was inferred from the unavailable observation',
      )
    const history = monitorHistory(1) as Array<{
      errors: number
      conditions: Array<{ detail: string }>
    }>
    expect(history[0]?.errors).toBe(1)
    expect(history[0]?.conditions[0]?.detail).toBe('docker inventory unavailable')
  })

  test('formats one human pass line, owner and severity included', () => {
    const rows = displayConditions([
      {
        kind: 'stale-run',
        subject: 'run:7',
        age_ms: 120_000,
        detail: 'detail here',
        action: 'do the thing',
        issue_key: 'DEV-1',
        severity: 'attention',
        owner_session_id: 'sess-9',
      },
      {
        kind: 'observation-error',
        subject: 'docker',
        age_ms: null,
        detail: 'inventory failed',
        action: 'retry',
        issue_key: null,
        severity: null,
        owner_session_id: null,
      },
    ])
    expect(rows).toEqual([
      {
        kind: 'stale-run',
        subject: 'run:7',
        ageMs: 120_000,
        detail: 'detail here',
        action: 'do the thing',
        issueKey: 'DEV-1',
        severity: 'attention',
        ownerSession: 'sess-9',
      },
      {
        kind: 'observation-error',
        subject: 'docker',
        ageMs: null,
        detail: 'inventory failed',
        action: 'retry',
        issueKey: null,
        severity: null,
        ownerSession: null,
      },
    ])
  })

  test('bounds every human-rendered condition detail', () => {
    const rendered = formatMonitorPass('monitor pass', [
      {
        kind: 'stale-run',
        subject: 'run:7',
        ageMs: 120_000,
        detail: 'x'.repeat(MONITOR_DETAIL_CHARS + 20),
        action: 'do the thing',
        ownerSession: null,
      },
    ])

    expect(rendered[1]?.split('\n')[1]).toBe(`    ${'x'.repeat(MONITOR_DETAIL_CHARS - 1)}…`)
  })

  test('pipes a complete large monitor history JSON document', async () => {
    const invocation = (
      db()
        .query(
          `INSERT INTO monitor_invocation (record_id,started_at,finished_at,trigger,findings,errors)
       VALUES (?,'2026-09-04T00:00:00Z','2026-09-04T00:00:01Z','backstop',1,0)
       RETURNING record_id`,
        )
        .get(newRecordId()) as { record_id: string }
    ).record_id
    const detail = 'history-detail-'.repeat(5_500)
    db()
      .query(
        `INSERT INTO monitor_condition
       (record_id,invocation_record_id,kind,subject,condition_since,age_ms,detail,action)
       VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        newRecordId(),
        invocation,
        'stale-run',
        'run:large-history',
        '2026-09-03T08:00:00Z',
        57_600_000,
        detail,
        'reported',
      )

    const history = monitorHistory(20) as Array<{ conditions: Array<{ detail: string }> }>
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(65_536)
    expect(history[0]?.conditions[0]?.detail).toBe(detail)
  })
})
