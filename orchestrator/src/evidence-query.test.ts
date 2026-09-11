import { describe, expect, test } from 'bun:test'
import { addRun, db, pendingForSession, runList, score, state } from '../test/fixture.ts'
import { runTotals } from './evidence-query.ts'

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

describe('evidence totals', () => {
  test('doctor excludes scores on not-evidence runs from its scored count', () => {
    score(addRun({ agent: 'codex', job: 'file-question' }), 'full', 'right'); const excluded = addRun({ agent: 'codex', job: 'file-question', status: 'failed' }); db().query("UPDATE run SET failure_kind='interrupted' WHERE id=?").run(excluded); score(excluded, 'none')
    expect(runTotals()).toMatchObject({ runs: 2, scored: 1, voided: 0, unscored: 0 })
  })
  test('doctor reports a voided verdict separately from scored routing evidence', () => {
    const kept = addRun({ agent: 'codex', job: 'file-question' }); const voided = addRun({ agent: 'codex', job: 'file-question' }); score(kept, 'full', 'right'); score(voided, 'full', 'right'); db().query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?").run(voided)
    expect(runTotals()).toMatchObject({ runs: 2, scored: 1, voided: 1, unscored: 0 })
  })
  test('a no-verdict void is accounted for by doctor and state totals, which agree', () => {
    const kept = addRun({ agent: 'codex', job: 'file-question' }); const voided = addRun({ agent: 'codex', job: 'file-question' }); score(kept, 'full', 'right'); db().query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?").run(voided)
    expect(runTotals()).toMatchObject({ runs: 2, scored: 1, voided: 1, unscored: 0 }); expect(state(null).totals).toMatchObject({ runs: 2, scored: 1, voided: 1 })
  })
  test('a voided not-evidence run is voided, not dropped from every bucket', () => {
    const id = addRun({ agent: 'codex', job: 'file-question', status: 'failed' }); db().query("UPDATE run SET failure_kind='interrupted',evidence_excluded='voided with orch score --void' WHERE id=?").run(id)
    expect(runTotals()).toMatchObject({ runs: 1, scored: 0, voided: 1, unscored: 0 })
  })
  test('pending says rescore when a later turn moved a judged chain', () => {
    const root = addRun({ agent: 'codex', job: 'file-question', session: 's' }); score(root, 'full', 'right'); const child = addRun({ agent: 'codex', job: 'file-question', parent: root, turn: 2, session: 's' }); expect(pendingForSession('s')).toEqual([expect.objectContaining({ id: root, reason: expect.stringContaining('rescore') })]); expect(child).toBeGreaterThan(root)
  })
})

describe('session scoping', () => {
  test('only this session\'s own unscored runs are raised', () => {
    const mine = addRun({ agent: 'grok', job: 'craft' })
    const theirs = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('session-A', mine)
    db().query('UPDATE run SET session_id=? WHERE id=?').run('session-B', theirs)

    const pending = pendingForSession('session-A')
    expect(pending.map((r) => r.id)).toEqual([mine])
  })

  test('with no session id, nothing is claimed', () => {
    expect(pendingForSession(null)).toEqual([])
  })

  test('a scored run drops off the backlog', () => {
    const id = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET session_id=? WHERE id=?').run('s', id)
    expect(pendingForSession('s')).toHaveLength(1)
    score(id, 'full', 'right')
    expect(pendingForSession('s')).toHaveLength(0)
  })
})
