import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { addRun, dir, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { candidates } from '../route/route.ts'
import { weigh } from '../score/score.ts'
import { state } from '../state/serve.ts'
import {
  excludeSharedOutputRuns,
  pendingForSession,
  runTotals,
  SHARED_OUTPUT_REASON,
} from './evidence-query.ts'

test('runs --unscored uses the shared definition of an owed judgement', () => {
  const wanted = addRun({ agent: 'grok', job: 'craft', session: 'owed-session' })
  addRun({ agent: 'grok', job: 'craft', probe: 1, session: 'owed-session' })
  addRun({ agent: 'grok', job: 'craft', status: 'failed', session: 'owed-session' })
  addRun({ agent: 'grok', job: 'craft', status: 'running', session: 'owed-session' })
  const parent = addRun({ agent: 'grok', job: 'craft', status: 'failed', session: 'owed-session' })
  addRun({ agent: 'grok', job: 'craft', parent, turn: 2, session: 'owed-session' })
  expect(pendingForSession('owed-session').map((row) => row.id)).toEqual([wanted])
})

describe('the activity window', () => {
  /** A run backdated by `days`, so the window has something to exclude. */
  function agedRun(days: number, o: { agent: string; job: string; status?: string }) {
    const id = addRun(o)
    db()
      .query('UPDATE run SET started_at=? WHERE id=?')
      .run(new Date(Date.now() - days * 86_400_000).toISOString(), id)
    return id
  }

  test('the counters exclude runs outside the window', () => {
    agedRun(60, { agent: 'grok', job: 'craft', status: 'failed' }) // long ago
    agedRun(0, { agent: 'grok', job: 'craft', status: 'failed' }) // just now

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
    db()
      .query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?")
      .run(voided)

    expect(state(null).totals as { scored: number; voided: number }).toEqual(
      expect.objectContaining({ scored: 1, voided: 1 }),
    )
  })

  test('a no-verdict void is voided once, not missing and not scored', () => {
    score(agedRun(0, { agent: 'grok', job: 'craft' }), 'full', 'right')
    const noVerdict = agedRun(0, { agent: 'grok', job: 'craft' })
    db()
      .query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?")
      .run(noVerdict)

    expect(state(null).totals as { runs: number; scored: number; voided: number }).toEqual(
      expect.objectContaining({ runs: 2, scored: 1, voided: 1 }),
    )
    expect(state(null).unscored).toBe(0)
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
    score(addRun({ agent: 'codex', job: 'file-question' }), 'full', 'right')
    const excluded = addRun({ agent: 'codex', job: 'file-question', status: 'failed' })
    db().query("UPDATE run SET failure_kind='interrupted' WHERE id=?").run(excluded)
    score(excluded, 'none')
    expect(runTotals()).toMatchObject({ runs: 2, scored: 1, voided: 0, unscored: 0 })
  })
  test('doctor reports a voided verdict separately from scored routing evidence', () => {
    const kept = addRun({ agent: 'codex', job: 'file-question' })
    const voided = addRun({ agent: 'codex', job: 'file-question' })
    score(kept, 'full', 'right')
    score(voided, 'full', 'right')
    db()
      .query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?")
      .run(voided)
    expect(runTotals()).toMatchObject({ runs: 2, scored: 1, voided: 1, unscored: 0 })
  })
  test('a no-verdict void is accounted for by doctor and state totals, which agree', () => {
    const kept = addRun({ agent: 'codex', job: 'file-question' })
    const voided = addRun({ agent: 'codex', job: 'file-question' })
    score(kept, 'full', 'right')
    db()
      .query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?")
      .run(voided)
    expect(runTotals()).toMatchObject({ runs: 2, scored: 1, voided: 1, unscored: 0 })
    expect(state(null).totals).toMatchObject({ runs: 2, scored: 1, voided: 1 })
  })
  test('a voided not-evidence run is voided, not dropped from every bucket', () => {
    const id = addRun({ agent: 'codex', job: 'file-question', status: 'failed' })
    db()
      .query(
        "UPDATE run SET failure_kind='interrupted',evidence_excluded='voided with orch score --void' WHERE id=?",
      )
      .run(id)
    expect(runTotals()).toMatchObject({ runs: 1, scored: 0, voided: 1, unscored: 0 })
  })
  test('pending says rescore when a later turn moved a judged chain', () => {
    const root = addRun({ agent: 'codex', job: 'implement', session: 's' })
    score(root, 'full', 'right', 'faithful')
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2, session: 's' })
    expect(
      db()
        .query(
          'SELECT root.id root_id,latest.id latest_id,s.run_id scored_id FROM run root JOIN run latest ON latest.parent_run_id=root.id JOIN score s ON s.run_id=root.id WHERE root.id=?',
        )
        .get(root),
    ).toEqual({ root_id: root, latest_id: child, scored_id: root })
  })
})

describe('session scoping', () => {
  test("only this session's own unscored runs are raised", () => {
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

test('a quota failure is retained but its successful retry is the only evidence', () => {
  const first = addRun({ agent: 'codex', job: 'craft', status: 'failed', kind: 'quota' })
  const second = addRun({ agent: 'codex', job: 'craft' })
  db().query('UPDATE run SET retry_of=? WHERE id=?').run(first, second)
  score(second, 'full', 'right')
  expect(candidates('craft').find((row) => row.agent === 'codex')).toMatchObject({
    failures: 0,
    scored: 1,
    evidence: 1,
  })
})

test('a retry is linked to what it re-attempts', () => {
  const first = addRun({ agent: 'codex', job: 'review-lens', status: 'failed' })
  const second = addRun({ agent: 'codex', job: 'review-lens' })
  db().query('UPDATE run SET retry_of=? WHERE id=?').run(first, second)
  expect(db().query('SELECT retry_of FROM run WHERE id=?').get(second)).toEqual({ retry_of: first })
})

test('a scored collision is kept as a verdict and dropped from routing', () => {
  const kept = addRun({ agent: 'codex', job: 'review-lens' })
  score(kept, 'full', 'right')
  const a = addRun({ agent: 'codex', job: 'review-lens' })
  const b = addRun({ agent: 'codex', job: 'review-lens' })
  score(a, 'none')
  score(b, 'none')
  db().query("UPDATE run SET evidence_excluded='shared an output file' WHERE id IN (?,?)").run(a, b)
  expect(candidates('review-lens').find((row) => row.agent === 'codex')).toMatchObject({
    scored: 1,
    evidence: 1,
    score: weigh('full', 'right'),
  })
  expect(db().query('SELECT COUNT(*) n FROM score').get()).toEqual({ n: 3 })
})

test('the backfill stamps every member of a colliding group, and no unique path', () => {
  const shared = join(dir, 'collided.txt')
  const unique = join(dir, 'alone.txt')
  const a = addRun({ agent: 'codex', job: 'review-lens' })
  const b = addRun({ agent: 'codex', job: 'review-lens' })
  const c = addRun({ agent: 'codex', job: 'review-lens' })
  db().query('UPDATE run SET output_path=? WHERE id IN (?,?)').run(shared, a, b)
  db().query('UPDATE run SET output_path=? WHERE id=?').run(unique, c)
  expect(excludeSharedOutputRuns(db())).toBe(2)
  expect(
    db()
      .query('SELECT id,evidence_excluded why FROM run WHERE id IN (?,?,?) ORDER BY id')
      .all(a, b, c),
  ).toEqual([
    { id: a, why: SHARED_OUTPUT_REASON },
    { id: b, why: SHARED_OUTPUT_REASON },
    { id: c, why: null },
  ])
})

test('a reason already written is left alone', () => {
  const shared = join(dir, 'already.txt')
  const a = addRun({ agent: 'codex', job: 'review-lens' })
  const b = addRun({ agent: 'codex', job: 'review-lens' })
  db().query('UPDATE run SET output_path=? WHERE id IN (?,?)').run(shared, a, b)
  db().query("UPDATE run SET evidence_excluded='already set' WHERE id=?").run(a)
  expect(excludeSharedOutputRuns(db())).toBe(1)
  expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(a)).toEqual({
    evidence_excluded: 'already set',
  })
})
