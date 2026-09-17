import { describe, expect, test } from 'bun:test'
import { addRun } from '../test/fixtures/store.ts'
import { db, nowIso } from './db.ts'
import { NOT_EVIDENCE } from './failure/failure.ts'
import { candidates } from './route/route.ts'
import { PENDING_BOOTSTRAP_MS, reapStale, STALE_AFTER_MS } from './run-liveness.ts'

describe('reapStale', () => {
  test('elapsed time does not kill a legacy run while its pid is alive', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    // process.pid is certainly alive: this is the recycled-pid case, and the
    // elapsed time must not decide liveness.
    db()
      .query('UPDATE run SET started_at=?, pid=? WHERE id=?')
      .run(new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString(), process.pid, id)

    expect(reapStale(db())).toBe(0)
    expect(
      (db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }).status,
    ).toBe('running')
    expect(db().query('SELECT rowid FROM run_mutation_audit WHERE run_id=?').get(id)).toBeNull()
  })

  test('a recent run whose process is gone is swept at once, not in thirty minutes', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    // Nothing owns pid 2^22; it is above every configured pid_max.
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, id)
    const prior = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = 'session-B'
    try {
      expect(reapStale(db())).toBe(1)
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = prior
    }
    expect(
      db()
        .query('SELECT action, actor_session, reason FROM run_mutation_audit WHERE run_id=?')
        .get(id),
    ).toEqual({
      action: 'reap',
      actor_session: 'session-B',
      reason: 'pid 4194304 is not alive',
    })
  })

  test('the reaper says WHY it swept, so routing can discount it', () => {
    // Without the kind these rows are indistinguishable from an agent that
    // simply failed, and the router charges them accordingly.
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, id)
    reapStale(db())
    const r = db().query('SELECT status, failure_kind FROM run WHERE id=?').get(id) as {
      status: string
      failure_kind: 'interrupted'
    }
    expect(r.status).toBe('stale')
    expect(r.failure_kind).toBe('interrupted')
    expect(NOT_EVIDENCE).toContain(r.failure_kind)
  })

  test('a legacy run with no lease and no pid is swept at once', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=NULL WHERE id=?').run(id)
    expect(reapStale(db())).toBe(1)
  })

  test('a live recent run is left alone', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    expect(reapStale(db())).toBe(0)
  })

  test('reaping a running child inherits stale onto an asking root as evidence', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db()
      .query(
        `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
      )
      .run(root, nowIso(), 'answered', 'the ruling', nowIso())
    const child = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'running',
      parent: root,
      turn: 2,
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, child)

    expect(reapStale(db())).toBe(1)
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(child)).toEqual({
      status: 'stale',
      failure_kind: 'interrupted',
    })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(root)).toEqual({
      status: 'stale',
      failure_kind: null,
    })
    const grok = candidates('implement').find((c) => c.agent === 'grok')!
    expect(grok.failures).toBe(1)
    expect(grok.evidence).toBe(1)
  })

  test('a pid-less (pending) row older than the bootstrap bound is failed/harness', () => {
    const old = addRun({ agent: '(pending)', job: 'craft', status: 'running' })
    const young = addRun({ agent: '(pending)', job: 'craft', status: 'running' })
    db()
      .query('UPDATE run SET pid=NULL, started_at=? WHERE id=?')
      .run(new Date(Date.now() - PENDING_BOOTSTRAP_MS - 1000).toISOString(), old)
    db()
      .query('UPDATE run SET pid=NULL, started_at=? WHERE id=?')
      .run(new Date(Date.now() - 10_000).toISOString(), young)

    expect(reapStale(db())).toBe(1)
    const swept = db().query('SELECT status, failure_kind, error FROM run WHERE id=?').get(old) as {
      status: string
      failure_kind: string
      error: string
    }
    expect(swept).toEqual({
      status: 'failed',
      failure_kind: 'harness',
      error: 'the worker process never started',
    })
    expect(
      (db().query('SELECT status FROM run WHERE id=?').get(young) as { status: string }).status,
    ).toBe('running')
  })
})
