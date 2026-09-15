import { describe, expect, test } from 'bun:test'
import { db } from './db.ts'
import { displayConditions, monitorHistory } from './monitor.ts'

describe('operational monitor reports', () => {
  test('marks historical human output partial when that pass had an observation error', () => {
    const invocation = (
      db()
        .query(
          `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
       VALUES ('2026-09-04T00:00:00Z','2026-09-04T00:00:01Z','backstop',1,1) RETURNING id`,
        )
        .get() as { id: number }
    ).id
    db()
      .query(
        `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action)
       VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        invocation,
        'observation-error',
        `invocation:${invocation}:1`,
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

  test('pipes a complete large monitor history JSON document', async () => {
    const invocation = (
      db()
        .query(
          `INSERT INTO monitor_invocation (started_at,finished_at,trigger,findings,errors)
       VALUES ('2026-09-04T00:00:00Z','2026-09-04T00:00:01Z','backstop',1,0) RETURNING id`,
        )
        .get() as { id: number }
    ).id
    const detail = 'history-detail-'.repeat(5_500)
    db()
      .query(
        `INSERT INTO monitor_condition
       (invocation_id,kind,subject,condition_since,age_ms,detail,action)
       VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
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
