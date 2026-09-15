import { describe, expect, test } from 'bun:test'
import { addRun } from '../test/fixtures/store.ts'
import { insertContention } from './contention.ts'
import { db } from './db.ts'
import { harnessHealth } from './health.ts'

describe('harness health', () => {
  test('counts substituted and silent provenance by agent', () => {
    const now = new Date('2026-09-07T12:00:00.000Z')
    const substituted = addRun({
      agent: 'grok',
      job: 'review-lens',
      startedAt: '2026-09-07T10:00:00.000Z',
    })
    const silent = addRun({
      agent: 'grok',
      job: 'review-lens',
      startedAt: '2026-09-07T11:00:00.000Z',
    })
    db()
      .query('UPDATE run SET review_provenance=?, provenance_status=? WHERE id=?')
      .run(
        JSON.stringify({
          substitutes: ['mirror for requested MCP'],
          could_not_verify: ['MCP unavailable'],
        }),
        null,
        substituted,
      )
    db()
      .query('UPDATE run SET review_provenance=?, provenance_status=? WHERE id=?')
      .run(JSON.stringify({ substitutes: [], could_not_verify: [] }), 'silent', silent)
    expect(harnessHealth(1, db(), now).provenance).toEqual([
      { agent: 'grok', substituted: 1, silent: 1 },
    ])
  })

  test('escaped class attribution counts every confinement event in the window', () => {
    const now = new Date('2026-09-07T12:00:00.000Z')
    const overlapping = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'failed',
      kind: 'escaped',
      startedAt: '2026-09-06T10:00:00.000Z',
    })
    const completed = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      startedAt: '2026-09-06T11:00:00.000Z',
    })
    const landing = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      startedAt: '2026-09-07T09:00:00.000Z',
    })
    db()
      .query('UPDATE run SET confinement=? WHERE id=?')
      .run(
        JSON.stringify({
          classification: 'overlapping',
          attribution: 'lock_holder',
        }),
        overlapping,
      )
    db()
      .query('UPDATE run SET confinement=? WHERE id=?')
      .run(
        JSON.stringify({
          classification: 'non_overlapping',
          attribution: 'unattributed',
        }),
        completed,
      )
    db()
      .query('UPDATE run SET confinement=? WHERE id=?')
      .run(
        JSON.stringify({
          classification: 'edit_commit_cycle',
          attribution: 'landing',
        }),
        landing,
      )
    const report = harnessHealth(14, db(), now)
    expect(report.classes.find((row) => row.kind === 'escaped')?.attribution).toEqual({
      lock_holder: 1,
      landing: 1,
      unattributed: 1,
    })
  })

  test('uses UTC-midnight boundaries for both counts and sparkline buckets', () => {
    const now = new Date('2026-09-07T12:00:00.000Z')
    addRun({
      agent: 'grok',
      job: 'review-lens',
      status: 'failed',
      kind: 'timeout',
      startedAt: '2026-09-05T00:00:00.000Z',
    })
    addRun({
      agent: 'grok',
      job: 'review-lens',
      status: 'failed',
      kind: 'timeout',
      startedAt: '2026-09-04T23:59:59.999Z',
    })
    addRun({
      agent: 'grok',
      job: 'review-lens',
      status: 'failed',
      kind: 'timeout',
      startedAt: '2026-09-07T11:00:00.000Z',
    })

    const report = harnessHealth(3, db(), now)
    const timeout = report.classes.find((row) => row.kind === 'timeout')!
    expect(report.from).toBe('2026-09-05T00:00:00.000Z')
    expect(timeout.count).toBe(2)
    expect(timeout.sparkline.reduce((sum, point) => sum + point.count, 0)).toBe(timeout.count)
  })

  test('contention sums per resource and names waits suffered versus invalidations caused', () => {
    const now = new Date('2026-09-07T12:00:00.000Z')
    insertContention(db(), {
      at: '2026-09-07T10:00:00.000Z',
      sessionId: 'session-a',
      resourceKind: 'lock',
      resourceKey: 'landing',
      eventKind: 'wait',
      durationMs: 1_000,
    })
    insertContention(db(), {
      at: '2026-09-07T10:01:00.000Z',
      sessionId: 'session-a',
      resourceKind: 'lock',
      resourceKey: 'landing',
      eventKind: 'wait',
      durationMs: 3_000,
    })
    insertContention(db(), {
      at: '2026-09-07T10:02:00.000Z',
      sessionId: 'session-b',
      resourceKind: 'review',
      resourceKey: 'victim',
      eventKind: 'invalidation',
      cause: 'review 9',
      landingId: 4,
    })
    insertContention(db(), {
      at: '2026-09-06T10:00:00.000Z',
      sessionId: 'session-b',
      resourceKind: 'lock',
      resourceKey: 'create',
      eventKind: 'wait',
      durationMs: 500,
    })
    insertContention(db(), {
      at: '2026-08-01T10:00:00.000Z',
      sessionId: 'session-a',
      resourceKind: 'lock',
      resourceKey: 'landing',
      eventKind: 'wait',
      durationMs: 9_000,
    })

    const report = harnessHealth(3, db(), now)
    expect(report.contention.resources.find((row) => row.kind === 'lock')).toMatchObject({
      count: 3,
      totalDurationMs: 4_500,
      meanDurationMs: 1_500,
      topKeys: [
        { key: 'landing', count: 2 },
        { key: 'create', count: 1 },
      ],
    })
    expect(report.contention.resources.find((row) => row.kind === 'review')).toMatchObject({
      count: 1,
      totalDurationMs: 0,
      meanDurationMs: 0,
      topKeys: [{ key: 'victim', count: 1 }],
    })
    expect(report.contention.sessions).toEqual([
      { sessionId: 'session-a', waitsSuffered: 2, invalidationsCaused: 0 },
      { sessionId: 'session-b', waitsSuffered: 1, invalidationsCaused: 1 },
    ])
    expect(report.header).toContain('never routing evidence')
  })
})
