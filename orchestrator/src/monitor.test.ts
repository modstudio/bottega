import { describe, expect, test } from 'bun:test'
import { NOT_EVIDENCE, PENDING_BOOTSTRAP_MS, STALE_AFTER_MS, addRun, candidates, db, nowIso, reapStale, runList, score, state } from '../test/fixture.ts'

describe('reapStale', () => {
  test('a run older than the cutoff is untouched while its pid is alive', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    // process.pid is certainly alive: this is the recycled-pid case, and the
    // age cutoff has to win it.
    db().query('UPDATE run SET started_at=?, pid=? WHERE id=?')
      .run(new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString(), process.pid, id)

    expect(reapStale(db())).toBe(0)
    expect((db().query('SELECT status FROM run WHERE id=?').get(id) as { status: string }).status)
      .toBe('running')
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
    expect(db().query(
      'SELECT action, actor_session, reason FROM run_mutation_audit WHERE run_id=?',
    ).get(id)).toEqual({
      action: 'reap', actor_session: 'session-B', reason: 'pid 4194304 is not alive',
    })
  })

  test('the reaper says WHY it swept, so routing can discount it', () => {
    // Without the kind these rows are indistinguishable from an agent that
    // simply failed, and the router charges them accordingly.
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, id)
    reapStale(db())
    const r = db().query('SELECT status, failure_kind FROM run WHERE id=?')
      .get(id) as { status: string; failure_kind: 'interrupted' }
    expect(r.status).toBe('stale')
    expect(r.failure_kind).toBe('interrupted')
    expect(NOT_EVIDENCE).toContain(r.failure_kind)
  })

  test('a recent run with NO pid cannot be swept, which is why one is recorded', () => {
    // The liveness check is guarded on `if (r.pid)`, so a row without one is
    // invisible to it and can only be cleared by the thirty-minute cutoff. That
    // is not a bug in the reaper - a pid it never had tells it nothing - it is
    // the reason detach() must write the WORKER's pid the moment it spawns.
    // Without that, a worker that died before starting an agent left a row
    // claiming to run, showing `(pending)` on the dashboard; four were sitting
    // there when this was found, one for fifteen minutes.
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=NULL WHERE id=?').run(id)
    expect(reapStale(db())).toBe(0)
    // With one, the very same dead worker is swept on the next pass.
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, id)
    expect(reapStale(db())).toBe(1)
  })

  test('a live recent run is left alone', () => {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
    expect(reapStale(db())).toBe(0)
  })

  test('reaping a running child inherits stale onto an asking root as evidence', () => {
    const root = addRun({ agent: 'grok', job: 'implement', status: 'asking' })
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'answered', 'the ruling', nowIso())
    const child = addRun({
      agent: 'grok', job: 'implement', status: 'running', parent: root, turn: 2,
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(4194304, child)

    expect(reapStale(db())).toBe(1)
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(child))
      .toEqual({ status: 'stale', failure_kind: 'interrupted' })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(root))
      .toEqual({ status: 'stale', failure_kind: null })
    const grok = candidates('implement').find((c) => c.agent === 'grok')!
    expect(grok.failures).toBe(1)
    expect(grok.evidence).toBe(1)
  })

  test('a pid-less (pending) row older than the bootstrap bound is failed/harness', () => {
    const old = addRun({ agent: '(pending)', job: 'craft', status: 'running' })
    const young = addRun({ agent: '(pending)', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=NULL, started_at=? WHERE id=?')
      .run(new Date(Date.now() - PENDING_BOOTSTRAP_MS - 1000).toISOString(), old)
    db().query('UPDATE run SET pid=NULL, started_at=? WHERE id=?')
      .run(new Date(Date.now() - 10_000).toISOString(), young)

    expect(reapStale(db())).toBe(1)
    const swept = db().query('SELECT status, failure_kind, error FROM run WHERE id=?')
      .get(old) as { status: string; failure_kind: string; error: string }
    expect(swept).toEqual({
      status: 'failed', failure_kind: 'harness', error: 'the worker process never started',
    })
    expect((db().query('SELECT status FROM run WHERE id=?').get(young) as { status: string }).status)
      .toBe('running')
  })
})

describe('the activity window', () => {
  /** A run backdated by `days`, so the window has something to exclude. */
  function agedRun(days: number, o: { agent: string; job: string; status?: string }) {
    const id = addRun(o)
    db().query('UPDATE run SET started_at=? WHERE id=?')
      .run(new Date(Date.now() - days * 86_400_000).toISOString(), id)
    return id
  }

  test('the counters exclude runs outside the window', () => {
    agedRun(60, { agent: 'grok', job: 'craft', status: 'failed' })   // long ago
    agedRun(0, { agent: 'grok', job: 'craft', status: 'failed' })    // just now

    expect((state(null).totals as { failed: number }).failed).toBe(2)
    expect((state(30).totals as { failed: number }).failed).toBe(1)
    expect((state(1).totals as { failed: number }).failed).toBe(1)
  })

  test('the scored counter excludes judgements on not-evidence runs', () => {
    score(agedRun(0, { agent: 'grok', job: 'craft' }), 'full', 'right')
    const interrupted = agedRun(0, { agent: 'grok', job: 'craft', status: 'failed' })
    db().query("UPDATE run SET failure_kind='interrupted' WHERE id=?").run(interrupted)
    score(interrupted, 'none')

    expect((state(null).totals as { scored: number }).scored).toBe(1)
  })

  test('a voided verdict is not scored routing evidence and is reported separately', () => {
    score(agedRun(0, { agent: 'grok', job: 'craft' }), 'full', 'right')
    const voided = agedRun(0, { agent: 'grok', job: 'craft' })
    score(voided, 'full', 'right')
    db().query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?").run(voided)

    expect(state(null).totals as { scored: number; voided: number }).toEqual(
      expect.objectContaining({ scored: 1, voided: 1 }),
    )
  })

  test('a no-verdict void is voided once, not missing and not scored', () => {
    score(agedRun(0, { agent: 'grok', job: 'craft' }), 'full', 'right')
    const noVerdict = agedRun(0, { agent: 'grok', job: 'craft' })
    db().query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?").run(noVerdict)

    expect(state(null).totals as { runs: number; scored: number; voided: number }).toEqual(
      expect.objectContaining({ runs: 2, scored: 1, voided: 1 }),
    )
    expect(state(null).unscored).toBe(0)
  })

  test("a voided 'none' does not file under the plain none verdict filter", () => {
    const plain = addRun({ agent: 'grok', job: 'craft' })
    score(plain, 'none')
    const voided = addRun({ agent: 'grok', job: 'craft' })
    score(voided, 'none')
    db().query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?").run(voided)

    const none = runList(new URLSearchParams({ verdict: 'none' }))
    const excluded = runList(new URLSearchParams({ verdict: 'excluded' }))
    expect((none.rows as { id: number }[]).map((row) => row.id)).toEqual([plain])
    expect((excluded.rows as { id: number }[]).map((row) => row.id)).toEqual([voided])
  })

  test('a fix can actually show up, which is the point of windowing at all', () => {
    // Nine stale runs all predate the try/finally. On a lifetime counter they
    // would announce that bug for ever; on a window they age out and the
    // counter starts telling the truth again.
    agedRun(10, { agent: 'grok', job: 'craft', status: 'stale' })
    expect((state(null).totals as { stale_n: number }).stale_n).toBe(1)
    // Zero, not null. SUM over no rows is NULL in SQLite while COUNT is 0, so
    // an empty window used to answer `failed: null` beside `runs: 0`.
    expect((state(7).totals as { stale_n: number }).stale_n).toBe(0)
  })

  test('the routing matrix is NOT windowed, whatever the band shows', () => {
    // The evidence base. A matrix narrowed to 24 hours would report an agent
    // has no runs while the router is confidently using twenty-six of them.
    score(agedRun(60, { agent: 'grok', job: 'craft' }), 'full', 'right')
    for (const days of [null, 30, 7, 1]) {
      expect((state(days).matrix as unknown[]).length).toBe(1)
    }
  })

  test('the runs-tab badge stays lifetime, so it does not change meaning', () => {
    agedRun(60, { agent: 'grok', job: 'craft' })
    agedRun(0, { agent: 'grok', job: 'craft' })
    expect(state(1).allTimeRuns).toBe(2)
    expect((state(1).totals as { runs: number }).runs).toBe(1)
  })
})
