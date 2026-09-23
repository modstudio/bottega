import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMemoryRecordApiClient, installRecordApiClient } from '../test/fixtures/record-api.ts'
import { reviewReply } from '../test/fixtures/replies.ts'
import { addRun, dir, score as seedScore } from '../test/fixtures/store.ts'
import { trackedTestResidue } from '../test/residue.ts'
import { db } from './database/db.ts'
import { NOT_EVIDENCE } from './failure/failure.ts'
import { judgeRun, scoreRun } from './judgement.ts'
import { completeReview, recordReview } from './review/review-triage.ts'
import { candidates } from './route/route.ts'
import { pairPartners } from './score/duel.ts'

const trackResidue = trackedTestResidue()

type FlagInput = Record<string, string | string[] | boolean>
const flags = (input: FlagInput = {}) => ({
  has: (name: string) =>
    input[name] === true || typeof input[name] === 'string' || Array.isArray(input[name]),
  flag: (name: string) =>
    typeof input[name] === 'string'
      ? (input[name] as string)
      : Array.isArray(input[name])
        ? (input[name] as string[])[0]
        : undefined,
  values: (name: string) =>
    Array.isArray(input[name])
      ? (input[name] as string[])
      : typeof input[name] === 'string'
        ? [input[name] as string]
        : [],
})
const presentation = {
  log: (..._values: unknown[]) => {},
  error: (..._values: unknown[]) => {},
  pairHint: (p: { id: number }) => `pair ${p.id}`,
}
const score = (
  id: number,
  words: string[],
  input: FlagInput = {},
  extra: { dashboardAuthorized?: boolean; note?: string | null; auditReason?: string | null } = {},
) =>
  scoreRun(
    id,
    flags(input),
    {
      words,
      note: extra.note ?? null,
      auditReason: extra.auditReason ?? null,
      notEvidence: NOT_EVIDENCE,
      dashboardAuthorized: extra.dashboardAuthorized ?? false,
    },
    presentation,
  )
const judge = (
  id: number,
  words: string[],
  input: FlagInput = {},
  extra: { note?: string | null; auditReason?: string | null } = {},
) =>
  judgeRun(
    id,
    flags(input),
    {
      words,
      note: extra.note ?? null,
      auditReason: extra.auditReason ?? null,
      notEvidence: NOT_EVIDENCE,
    },
    presentation,
  )
const insert = (status = 'ok', job = 'file-question') =>
  addRun({ agent: 'codex', job, status, session: process.env.CLAUDE_CODE_SESSION_ID ?? null })

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
})

describe('score ruling', () => {
  test('a leaf id scores the root of its conversation', async () => {
    const root = insert()
    const child = insert()
    db().query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?').run(root, child)
    await score(child, ['full', 'right'])
    expect(db().query('SELECT run_id FROM score').all()).toEqual([{ run_id: root }])
  })

  test('score refuses a harness-failed run even with force', async () => {
    const id = insert('failed')
    db().query("UPDATE run SET failure_kind='harness' WHERE id=?").run(id)
    await expect(score(id, ['none'], { force: true })).rejects.toThrow(
      "failure kind 'harness' is not evidence",
    )
    expect(db().query('SELECT * FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test("score refuses a run whose agent is '(pending)'", async () => {
    const id = insert('failed')
    db().query("UPDATE run SET agent='(pending)' WHERE id=?").run(id)
    await expect(score(id, ['none'])).rejects.toThrow("agent is the placeholder '(pending)'")
    expect(db().query('SELECT * FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test("score --void accepts only a harness-failed '(pending)' run", async () => {
    const harness = insert('failed')
    db().query("UPDATE run SET agent='(pending)',failure_kind='harness' WHERE id=?").run(harness)
    await score(harness, ['none'], { void: true })
    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(harness)).toEqual({
      evidence_excluded: 'voided with orch score --void',
    })
    const other = insert('failed')
    db().query("UPDATE run SET agent='(pending)',failure_kind='other' WHERE id=?").run(other)
    await expect(score(other, ['none'], { void: true })).rejects.toThrow(
      "agent is the placeholder '(pending)'",
    )
  })

  test('only a live hub serve capability lets the dashboard scorer cross ownership', async () => {
    const id = insert()
    db().query('UPDATE run SET session_id=? WHERE id=?').run('owner-session', id)
    process.env.CLAUDE_CODE_SESSION_ID = 'foreign-session'
    await expect(score(id, ['full', 'right'], { scorer: 'forged-dashboard' })).rejects.toThrow(
      'another session',
    )
    await score(id, ['full', 'right'], { scorer: 'hub-dashboard' }, { dashboardAuthorized: true })
    expect(db().query('SELECT scored_by FROM score WHERE run_id=?').get(id)).toEqual({
      scored_by: 'hub-dashboard',
    })
    await expect(
      score(id, [], { void: true, scorer: 'hub-dashboard' }, { dashboardAuthorized: true }),
    ).rejects.toThrow('owned by session owner-session')
  })

  test('an anonymous caller cannot score an unowned run', async () => {
    const id = insert()
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(id)
    delete process.env.CLAUDE_CODE_SESSION_ID
    await expect(score(id, ['full', 'right'])).rejects.toThrow('CLAUDE_CODE_SESSION_ID is not set')
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test('only the bridge id cannot score an unowned run', async () => {
    const id = insert()
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(id)
    delete process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = 'shared-bridge'
    await expect(score(id, ['full', 'right'])).rejects.toThrow('CLAUDE_CODE_SESSION_ID is not set')
  })

  test('bridge-only --force scores an unowned run without adopting', async () => {
    const id = insert()
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(id)
    delete process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_BRIDGE_SESSION_ID = 'shared-bridge'
    await score(id, ['full', 'right'], { force: true }, { auditReason: '--force' })
    expect(db().query('SELECT session_id FROM run WHERE id=?').get(id)).toEqual({
      session_id: null,
    })
    expect(db().query('SELECT delivery,quality FROM score WHERE run_id=?').get(id)).toEqual({
      delivery: 'full',
      quality: 'right',
    })
  })

  test('the first score adopts an unowned root and refuses foreign rescore and void', async () => {
    const id = insert()
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(id)
    process.env.CLAUDE_CODE_SESSION_ID = 'session-A'
    await score(id, ['full', 'right'])
    expect(db().query('SELECT session_id FROM run WHERE id=?').get(id)).toEqual({
      session_id: 'session-A',
    })
    process.env.CLAUDE_CODE_SESSION_ID = 'session-B'
    await expect(score(id, ['partial', 'mixed'])).rejects.toThrow('another session')
    await expect(score(id, [], { void: true })).rejects.toThrow('owned by session session-A')
    expect(db().query('SELECT delivery,quality FROM score WHERE run_id=?').get(id)).toEqual({
      delivery: 'full',
      quality: 'right',
    })
  })

  test('score refuses review grades on a job that does not produce findings', async () => {
    const id = insert()
    await expect(
      score(id, ['full', 'right'], {
        reproduced: 'all',
        coverage: 'adequate',
        limits: 'named',
        overlap: 'unique',
      }),
    ).rejects.toThrow('not a findings-producing lens')
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test('score refuses an owned run when the caller has no session identity', async () => {
    const id = insert('ok', 'review-lens')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('owner-session', id)
    delete process.env.CLAUDE_CODE_SESSION_ID
    await expect(score(id, ['full', 'right'])).rejects.toThrow('no session identity is present')
  })

  test('re-scoring keeps the old note and confirms every latest axis', async () => {
    const id = insert()
    await score(id, ['full', 'right'], {}, { note: 'first note' })
    await score(id, ['partial', 'mixed'], {}, { note: 'second note' })
    const row = db().query('SELECT delivery,quality,note FROM score WHERE run_id=?').get(id) as {
      delivery: string
      quality: string
      note: string
    }
    expect(row).toMatchObject({ delivery: 'partial', quality: 'mixed' })
    expect(row.note).toContain('first note')
    expect(row.note).toContain('second note')
  })

  test('scoring same-tree roots offers a pair and --worse-than records the inverse duel', async () => {
    const a = insert()
    const b = insert()
    db().query("UPDATE run SET spec_sha='same',input_tree='tree' WHERE id IN (?,?)").run(a, b)
    seedScore(a, 'full', 'right')
    expect(pairPartners(b, 'orch-test-session').map((p) => p.id)).toEqual([a])
    await score(b, ['full', 'right'], { 'worse-than': String(a) })
    expect(
      db()
        .query(
          'SELECT winner_run_id,loser_run_id FROM duel WHERE winner_run_id=? AND loser_run_id=?',
        )
        .get(a, b),
    ).toEqual({ winner_run_id: a, loser_run_id: b })
  })

  test('--same-as marks a scored pair compared without adding a duel', async () => {
    const a = insert()
    const b = insert()
    db().query("UPDATE run SET spec_sha='same',input_tree='tree' WHERE id IN (?,?)").run(a, b)
    seedScore(a, 'full', 'right')
    await score(b, ['full', 'right'], { 'same-as': String(a) })
    expect(
      db()
        .query(
          'SELECT COUNT(*) n FROM duel WHERE (winner_run_id=? AND loser_run_id=?) OR (winner_run_id=? AND loser_run_id=?)',
        )
        .get(a, b, b, a),
    ).toEqual({ n: 0 })
    expect(db().query('SELECT run_a_id,run_b_id FROM compared_pair').all()).toEqual([
      { run_a_id: a, run_b_id: b },
    ])
  })

  test('inline roots with the same task-prompt hash are offered as partners', async () => {
    const a = insert()
    const b = insert()
    db()
      .query("UPDATE run SET prompt_sha='same',spec_sha='same',input_tree=NULL WHERE id IN (?,?)")
      .run(a, b)
    seedScore(a, 'full', 'right')
    expect(pairPartners(b, 'orch-test-session').map((p) => p.id)).toEqual([a])
  })

  test('score --void without a new verdict keeps the existing score', async () => {
    const id = insert()
    await score(id, ['full', 'right'])
    await score(id, [], { void: true })
    expect(db().query('SELECT delivery,quality FROM score WHERE run_id=?').get(id)).toEqual({
      delivery: 'full',
      quality: 'right',
    })
  })

  test('score and re-score store the merged note locally and keep one current score outbox row', async () => {
    const id = insert()
    await score(id, ['full', 'right'], {}, { note: 'first' })
    await score(id, ['partial', 'mixed'], {}, { note: 'second' })
    const stored = db()
      .query<{ delivery: string; quality: string; note: string }, [number]>(
        'SELECT delivery, quality, note FROM score WHERE run_id=?',
      )
      .get(id)
    expect(stored).toMatchObject({ delivery: 'partial', quality: 'mixed' })
    expect(stored!.note).toContain('first')
    expect(stored!.note).toContain('second')
    expect(db().query<{ n: number }, []>('SELECT count(*) AS n FROM score').get()!.n).toBe(1)
    const outbox = db()
      .query<{ n: number; payload: string }, []>(
        "SELECT count(*) AS n, payload FROM outbox WHERE kind='score'",
      )
      .get()!
    expect(outbox.n).toBe(1)
    expect(JSON.parse(outbox.payload)).toMatchObject({
      delivery: 'partial',
      quality: 'mixed',
      note: expect.stringContaining('second'),
    })
  })

  test('no pair offer across different spec_sha', async () => {
    const a = insert()
    const b = insert()
    db().query("UPDATE run SET input_tree='tree',spec_sha='one' WHERE id=?").run(a)
    db().query("UPDATE run SET input_tree='tree',spec_sha='two' WHERE id=?").run(b)
    seedScore(a, 'full', 'right')
    expect(pairPartners(b, 'orch-test-session')).toEqual([])
  })

  test('a scored probe partner is excluded from score, pending, and Stop-hook pair offers', async () => {
    const a = insert()
    const b = insert()
    db().query("UPDATE run SET input_tree='tree',spec_sha='same',probe=1 WHERE id=?").run(a)
    db().query("UPDATE run SET input_tree='tree',spec_sha='same' WHERE id=?").run(b)
    seedScore(a, 'full', 'right')
    expect(pairPartners(b, 'orch-test-session')).toEqual([])
  })

  test('an evidence-excluded partner is excluded from score, pending, and Stop-hook pair offers', async () => {
    const a = insert()
    const b = insert()
    db()
      .query(
        "UPDATE run SET input_tree='tree',spec_sha='same',evidence_excluded='operator void' WHERE id=?",
      )
      .run(a)
    db().query("UPDATE run SET input_tree='tree',spec_sha='same' WHERE id=?").run(b)
    seedScore(a, 'full', 'right')
    expect(pairPartners(b, 'orch-test-session')).toEqual([])
  })
})

describe('judge ruling', () => {
  test('score drops a habitual fidelity word for a review lens and records two axes', async () => {
    const id = insert('ok', 'review-lens')
    const output = trackResidue(join(dir, `graded-${id}.json`))
    writeFileSync(output, JSON.stringify(reviewReply(1)))
    db()
      .query('UPDATE run SET lens=?,model=?,output_path=? WHERE id=?')
      .run('correctness', 'm', output, id)
    await score(id, ['full', 'right'], {
      reproduced: 'all',
      coverage: 'adequate',
      limits: 'absent',
      overlap: 'alone',
    })
    expect(
      db().query('SELECT delivery,quality,fidelity FROM score WHERE run_id=?').get(id),
    ).toEqual({ delivery: 'full', quality: 'right', fidelity: null })
  })

  test('lens scoring refuses missing grades with the canonical vocabulary and writes nothing', async () => {
    const id = insert('ok', 'review-lens')
    const output = trackResidue(join(dir, `ungraded-${id}.json`))
    writeFileSync(output, JSON.stringify(reviewReply(1)))
    db()
      .query('UPDATE run SET lens=?,model=?,output_path=? WHERE id=?')
      .run('safety', 'm', output, id)
    await expect(score(id, ['full', 'right'])).rejects.toThrow(/reproduced/)
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test('lens scoring updates an already-recorded review row instead of creating another review', async () => {
    const id = insert('ok', 'review-lens')
    db().query('UPDATE run SET lens=?,model=? WHERE id=?').run('existing', 'm', id)
    const reviewId = recordReview(id, reviewReply(1), db())
    const before = (db().query('SELECT COUNT(*) n FROM review').get() as { n: number }).n
    await score(id, ['partial', 'mixed'], {
      reproduced: 'some',
      coverage: 'partial',
      limits: 'named',
      overlap: 'shared',
    })
    expect((db().query('SELECT COUNT(*) n FROM review').get() as { n: number }).n).toBe(before)
    expect(
      db().query('SELECT review_id,reproduced FROM review_lens WHERE run_id=?').get(id),
    ).toEqual({ review_id: reviewId, reproduced: 'some' })
  })

  test('an empty lens defaults reproduced and overlap while delivery none captures nothing', async () => {
    const failed = insert('failed', 'safety')
    db().query("UPDATE run SET failure_kind='other' WHERE id=?").run(failed)
    await score(failed, ['none'])
    expect(db().query('SELECT id FROM review_lens WHERE run_id=?').get(failed)).toBeNull()
  })

  test('score refuses an unevidenced clean lens without creating score or review rows', async () => {
    const id = insert('ok', 'review-lens')
    db()
      .query("UPDATE run SET failure_kind='unevidenced',lens='empty',model='m' WHERE id=?")
      .run(id)
    await expect(
      score(id, ['full', 'right'], { coverage: 'empty', limits: 'named' }),
    ).rejects.toThrow('unevidenced review')
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test('duplicate singleton review grades are refused without recording a score or review', async () => {
    const id = insert('ok', 'review-lens')
    const output = trackResidue(join(dir, `duplicate-${id}.json`))
    writeFileSync(output, JSON.stringify(reviewReply(1)))
    db()
      .query('UPDATE run SET lens=?,model=?,output_path=? WHERE id=?')
      .run('duplicate', 'm', output, id)
    await expect(
      score(id, ['full', 'right'], {
        reproduced: 'banana',
        coverage: 'adequate',
        limits: 'named',
        overlap: 'unique',
      }),
    ).rejects.toThrow('--reproduced')
  })

  test('judge closes a two-finding review and pair in one transaction', async () => {
    const partner = insert('ok', 'review-lens')
    const id = insert('ok', 'review-lens')
    for (const run of [partner, id])
      db()
        .query(
          "UPDATE run SET lens='correctness',model='m',spec_sha='same',input_tree='tree' WHERE id=?",
        )
        .run(run)
    recordReview(id, reviewReply(2, 'high'), db())
    seedScore(partner, 'full', 'right')
    await judge(id, ['full', 'right'], {
      reproduced: 'all',
      coverage: 'adequate',
      limits: 'absent',
      overlap: 'alone',
      finding: ['1=accepted:high', '2=modified:medium'],
      'better-than': String(partner),
    })
    expect(
      db()
        .query(
          'SELECT completed_at FROM review WHERE id=(SELECT review_id FROM review_lens WHERE run_id=?)',
        )
        .get(id),
    ).toEqual({ completed_at: expect.any(String) })
  })

  test('judge records a findings verdict locally and enqueues it while the record is unreachable', async () => {
    const id = insert('ok', 'review-lens')
    db().query("UPDATE run SET lens='correctness',model='m' WHERE id=?").run(id)
    const reviewId = recordReview(id, reviewReply(2, 'high'), db())
    const unavailable = createMemoryRecordApiClient()
    installRecordApiClient({
      ...unavailable,
      putScore: async () => {
        throw new Error('fixture record unreachable')
      },
    })

    await judge(id, ['full', 'right'], {
      reproduced: 'all',
      coverage: 'adequate',
      limits: 'absent',
      overlap: 'alone',
      finding: ['1=accepted:high', '2=modified:medium'],
    })

    expect(db().query('SELECT delivery,quality FROM score WHERE run_id=?').get(id)).toEqual({
      delivery: 'full',
      quality: 'right',
    })
    expect(
      db()
        .query('SELECT reproduced,coverage,limits,overlap FROM review_lens WHERE run_id=?')
        .get(id),
    ).toEqual({ reproduced: 'all', coverage: 'adequate', limits: 'absent', overlap: 'alone' })
    expect(
      db()
        .query(
          'SELECT ordinal,disposition,triaged_severity FROM review_finding WHERE review_id=? ORDER BY ordinal',
        )
        .all(reviewId),
    ).toEqual([
      { ordinal: 1, disposition: 'accepted', triaged_severity: 'high' },
      { ordinal: 2, disposition: 'modified', triaged_severity: 'medium' },
    ])
    expect(db().query('SELECT completed_at FROM review WHERE id=?').get(reviewId)).toEqual({
      completed_at: expect.any(String),
    })
    expect(db().query("SELECT count(*) count FROM outbox WHERE kind='score'").get()).toEqual({
      count: 1,
    })
    const payload = db()
      .query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='score'")
      .get()!
    expect(JSON.parse(payload.payload)).toMatchObject({
      reproduced: 'all',
      coverage: 'adequate',
      limits: 'absent',
      overlap: 'alone',
    })
  })

  test('wiped stored findings refuse judging, scoring, and completion', async () => {
    const id = insert('ok', 'review-lens')
    const output = trackResidue(join(dir, `wiped-findings-${id}.json`))
    writeFileSync(output, JSON.stringify(reviewReply(2, 'high')))
    db()
      .query('UPDATE run SET lens=?,model=?,output_path=? WHERE id=?')
      .run('correctness', 'm', output, id)
    const reviewId = recordReview(id, reviewReply(2, 'high'), db())
    db().query('DELETE FROM review_finding WHERE review_id=?').run(reviewId)

    const integrity =
      `review finding integrity error for run ${id}: persisted reply has 2 findings ` +
      'but stored rows have 0; restore the missing review_finding rows'
    await expect(
      judge(id, ['full', 'right'], {
        reproduced: 'all',
        coverage: 'adequate',
        limits: 'absent',
        overlap: 'alone',
      }),
    ).rejects.toThrow(integrity)
    await expect(
      score(id, ['full', 'right'], {
        reproduced: 'all',
        coverage: 'adequate',
        limits: 'absent',
        overlap: 'alone',
      }),
    ).rejects.toThrow(integrity)
    expect(() => completeReview(reviewId, db())).toThrow(integrity)
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
    expect(db().query('SELECT completed_at FROM review WHERE id=?').get(reviewId)).toEqual({
      completed_at: null,
    })
  })

  test('judge rolls every close-out write back when a finding flag fails during the transaction', async () => {
    const id = insert('ok', 'review-lens')
    db().query("UPDATE run SET lens='correctness',model='m' WHERE id=?").run(id)
    recordReview(id, reviewReply(1), db())
    await expect(
      judge(id, ['full', 'right'], {
        reproduced: 'all',
        coverage: 'adequate',
        limits: 'absent',
        overlap: 'alone',
        finding: ['2=accepted:high'],
      }),
    ).rejects.toThrow('has no finding 2')
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test('score and judge read notes from files and reject shell-fragment notes', async () => {
    const scored = insert()
    await score(scored, ['full', 'right'], {}, { note: 'long note\nwith a second line' })
    expect(
      (db().query('SELECT note FROM score WHERE run_id=?').get(scored) as { note: string }).note,
    ).toContain('second line')
    const judged = insert('ok', 'implement')
    await judge(
      judged,
      ['full', 'right', 'faithful'],
      {},
      { note: 'long note\nwith a second line' },
    )
    expect(
      (db().query('SELECT note FROM score WHERE run_id=?').get(judged) as { note: string }).note,
    ).toContain('second line')
  })

  test('same task-prompt pairs key on recorded change identity and matching lenses', async () => {
    const a = insert('ok', 'review-lens')
    const b = insert('ok', 'review-lens')
    for (const id of [a, b])
      db().query("UPDATE run SET lens='correctness',model='m',spec_sha='same' WHERE id=?").run(id)
    const reviewA = recordReview(a, reviewReply(1), db())
    const reviewB = recordReview(b, reviewReply(1), db())
    db()
      .query("UPDATE review SET patch_id='patch',path_set='[\"x.ts\"]' WHERE id IN (?,?)")
      .run(reviewA, reviewB)
    seedScore(a, 'full', 'right')
    expect(pairPartners(b, 'orch-test-session').map((p) => p.id)).toEqual([a])
  })

  test('judge closes a writer score with fidelity', async () => {
    const id = insert('ok', 'implement')
    await judge(id, ['full', 'right', 'faithful'])
    expect(
      db().query('SELECT delivery,quality,fidelity FROM score WHERE run_id=?').get(id),
    ).toEqual({ delivery: 'full', quality: 'right', fidelity: 'faithful' })
  })

  test('judge lists every missing writer axis in one refusal', async () => {
    const id = insert('ok', 'implement')
    await expect(judge(id, [])).rejects.toThrow(/<none\|partial\|full>[\s\S]*<wrong\|mixed\|right>/)
    expect(db().query('SELECT id FROM score WHERE run_id=?').get(id)).toBeNull()
  })

  test('judge none closes review debt without entering reviewer calibration', async () => {
    const id = insert('ok', 'review-lens')
    db().query('UPDATE run SET lens=?,model=? WHERE id=?').run('correctness', 'm', id)
    const reviewId = recordReview(id, reviewReply(1), db())
    db().query("UPDATE run SET status='failed' WHERE id=?").run(id)
    await judge(id, ['none'])
    expect(db().query('SELECT completed_at FROM review WHERE id=?').get(reviewId)).toEqual({
      completed_at: expect.any(String),
    })
    expect(
      db().query('SELECT disposition FROM review_finding WHERE review_id=?').get(reviewId),
    ).toEqual({ disposition: null })
  })
})

describe('voided output evidence', () => {
  test('score --blocked-by-tree uses the void routing exclusion without recording a verdict', async () => {
    const kept = insert('ok', 'understand')
    const blocked = insert('ok', 'understand')
    seedScore(kept, 'full', 'right')
    await score(
      blocked,
      [],
      { 'blocked-by-tree': true },
      { note: 'the seeded database could not start' },
    )
    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(blocked)).toEqual({
      evidence_excluded: 'blocked by its tree: the seeded database could not start',
    })
    expect(db().query('SELECT * FROM score WHERE run_id=?').get(blocked)).toBeNull()
    expect(candidates('understand').find((row) => row.agent === 'codex')).toMatchObject({
      scored: 1,
      evidence: 1,
    })
  })

  test('score --void records its verdict but removes routing and duel evidence', async () => {
    const outputPath = trackResidue(join(dir, 'voided-output.txt'))
    writeFileSync(outputPath, 'the retained answer')
    const id = insert('ok', 'review-lens')
    const partner = addRun({
      agent: 'grok',
      job: 'review-lens',
      session: 'orch-test-session',
      inputTree: 'voided-tree',
      specSha: 'voided-spec',
    })
    db()
      .query(
        "UPDATE run SET output_path=?,input_tree='voided-tree',spec_sha='voided-spec' WHERE id=?",
      )
      .run(outputPath, id)
    seedScore(partner, 'full', 'right')
    await score(id, ['none'], { void: true, 'better-than': String(partner) })
    expect(readFileSync(outputPath, 'utf8')).toBe('the retained answer')
    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(id)).toEqual({
      evidence_excluded: 'voided with orch score --void',
    })
    expect(db().query('SELECT delivery,quality FROM score WHERE run_id=?').get(id)).toEqual({
      delivery: 'none',
      quality: null,
    })
    const outbox = db()
      .query<{ kind: string; payload: string }, [number]>(
        `SELECT kind,payload FROM outbox
          WHERE record_id=(SELECT record_id FROM run WHERE id=?) ORDER BY id`,
      )
      .all(id)
    expect(outbox.map((row) => row.kind)).toEqual(['score', 'run'])
    expect(JSON.parse(outbox[1]!.payload)).toMatchObject({
      evidenceExcluded: 'voided with orch score --void',
    })
    expect(
      db().query('SELECT COUNT(*) n FROM duel WHERE winner_run_id=? OR loser_run_id=?').get(id, id),
    ).toEqual({ n: 0 })
    expect(
      db().query('SELECT action,actor_session FROM run_mutation_audit WHERE run_id=?').get(id),
    ).toEqual({ action: 'void', actor_session: 'orch-test-session' })
  })

  test('score --void rolls back the exclusion when recording the verdict fails', async () => {
    const id = insert('ok', 'understand')
    db().exec(
      `CREATE TRIGGER reject_void_score BEFORE INSERT ON score WHEN NEW.run_id=${id} BEGIN SELECT RAISE(ABORT,'fixture score refusal'); END`,
    )
    try {
      await expect(score(id, ['none'], { void: true })).rejects.toThrow('fixture score refusal')
    } finally {
      db().exec('DROP TRIGGER reject_void_score')
    }
    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(id)).toEqual({
      evidence_excluded: null,
    })
    expect(db().query('SELECT COUNT(*) n FROM score WHERE run_id=?').get(id)).toEqual({ n: 0 })
    expect(
      db()
        .query<{ n: number }, [number]>(
          'SELECT COUNT(*) n FROM outbox WHERE record_id=(SELECT record_id FROM run WHERE id=?)',
        )
        .get(id),
    ).toEqual({ n: 0 })
  })

  test('score --void says why a NOT_EVIDENCE failure verdict was not recorded', async () => {
    const id = insert('failed', 'understand')
    db().query("UPDATE run SET failure_kind='quota' WHERE id=?").run(id)
    const lines: string[] = []
    await scoreRun(
      id,
      flags({ void: true }),
      {
        words: ['none'],
        note: null,
        auditReason: null,
        notEvidence: NOT_EVIDENCE,
        dashboardAuthorized: false,
      },
      { ...presentation, log: (...values) => lines.push(values.join(' ')) },
    )
    expect(lines.join('\n')).toContain(
      "verdict was not recorded: failure kind 'quota' is not evidence",
    )
    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(id)).toEqual({
      evidence_excluded: 'voided with orch score --void',
    })
    expect(db().query('SELECT COUNT(*) n FROM score WHERE run_id=?').get(id)).toEqual({ n: 0 })
  })

  test('score --void refuses a foreign owner and permits an attributed unowned run', async () => {
    const owned = insert('ok', 'review-lens')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('owner-session', owned)
    process.env.CLAUDE_CODE_SESSION_ID = 'foreign-session'
    await expect(score(owned, [], { void: true })).rejects.toThrow('owner-session')
    expect(db().query('SELECT evidence_excluded FROM run WHERE id=?').get(owned)).toEqual({
      evidence_excluded: null,
    })
    const unowned = insert('ok', 'review-lens')
    db().query('UPDATE run SET session_id=NULL WHERE id=?').run(unowned)
    process.env.CLAUDE_CODE_SESSION_ID = 'acting-session'
    await score(unowned, [], { void: true })
    expect(
      db()
        .query(
          'SELECT action,actor_session,reason FROM run_mutation_audit WHERE run_id=? ORDER BY rowid',
        )
        .all(unowned),
    ).toEqual([
      { action: 'adopt', actor_session: 'acting-session', reason: 'before void' },
      { action: 'void', actor_session: 'acting-session', reason: null },
    ])
  })
})
