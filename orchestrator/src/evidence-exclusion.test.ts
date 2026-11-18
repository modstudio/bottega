import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../shared/record-id.ts'
import { type FlagInput, flags } from '../test/fixtures/judgment.ts'
import { addRun, dir, score as seedScore } from '../test/fixtures/store.ts'
import { trackedTestResidue } from '../test/residue.ts'
import { db } from './database/db.ts'
import { NOT_EVIDENCE } from './failure/failure.ts'
import { scoreRun } from './judgment.ts'
import { candidates } from './route/route.ts'
import { VOID_EXCLUSION_REASON } from './verdict/verdict-rules.ts'

const trackResidue = trackedTestResidue()
const presentation = {
  log: (..._values: unknown[]) => {},
  error: (..._values: unknown[]) => {},
  pairHint: (p: { id: string }) => `pair ${p.id}`,
}
const score = (
  id: string,
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
const insert = (status = 'ok', job = 'file-question') =>
  addRun({ agent: 'codex', job, status, session: process.env.CLAUDE_CODE_SESSION_ID ?? null })

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  delete process.env.CLAUDE_CODE_BRIDGE_SESSION_ID
})

describe('evidence exclusion', () => {
  test('void without a new verdict keeps the existing score', async () => {
    const id = insert()
    await score(id, ['full', 'right'])
    await score(id, [], { void: true })
    expect(db().query('SELECT delivery,quality FROM score WHERE run_record_id=?').get(id)).toEqual({
      delivery: 'full',
      quality: 'right',
    })
  })

  test('score --void refuses an unusable third word without changing stored evidence', async () => {
    const id = insert()
    await score(id, ['partial', 'right'], {}, { note: 'kept void note' })
    const snapshot = () =>
      db()
        .query(
          `SELECT score.delivery,score.quality,score.fidelity,score.note,run.evidence_excluded
             FROM run JOIN score ON score.run_record_id=run.record_id WHERE run.record_id=?`,
        )
        .get(id)
    const before = snapshot()

    await expect(
      score(id, ['full', 'mixed', 'xyz'], { void: true }, { note: 'replacement void note' }),
    ).rejects.toThrow("'xyz' is not a verdict word for file-question; remove it")
    expect(snapshot()).toEqual(before)
  })

  test('leaves an asking chain and its question open', async () => {
    const id = insert('asking', 'review-lens')
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
      )
      .run(id, '2026-09-29', 'Which behavior is correct?')
    await score(id, [], { void: true })
    expect(
      db().query('SELECT status,evidence_excluded FROM run WHERE record_id=?').get(id),
    ).toEqual({ status: 'asking', evidence_excluded: VOID_EXCLUSION_REASON })
    expect(
      db()
        .query('SELECT answered_at,closed_at,close_reason FROM question WHERE run_record_id=?')
        .get(id),
    ).toEqual({ answered_at: null, closed_at: null, close_reason: null })
  })

  test('unvoid resolves a turn to its root, keeps the score, audits, and enqueues', async () => {
    const root = insert('ok', 'review-lens')
    const turn = addRun({
      agent: 'codex',
      job: 'review-lens',
      status: 'ok',
      session: 'orch-test-session',
      parent: root,
    })
    seedScore(root, 'full', 'right')
    db()
      .query('UPDATE run SET evidence_excluded=? WHERE record_id=?')
      .run(VOID_EXCLUSION_REASON, root)
    await score(turn, [], { unvoid: true }, { note: 'void targeted the wrong run' })
    expect(db().query('SELECT evidence_excluded FROM run WHERE record_id=?').get(root)).toEqual({
      evidence_excluded: null,
    })
    expect(
      db()
        .query(
          'SELECT action,reason FROM run_mutation_audit WHERE run_record_id=? ORDER BY rowid DESC',
        )
        .get(root),
    ).toEqual({ action: 'unvoid', reason: 'void targeted the wrong run' })
    const payload = db()
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM outbox
WHERE row_id=(SELECT record_id FROM run WHERE record_id=?) ORDER BY id DESC`,
      )
      .get(root)
    expect(JSON.parse(payload!.payload)).toMatchObject({
      evidenceExcluded: null,
      evidenceUnvoid: { note: 'void targeted the wrong run' },
    })
  })

  test('unvoid requires a note and refuses other exclusions and verdicts', async () => {
    const id = insert('ok', 'review-lens')
    db()
      .query('UPDATE run SET evidence_excluded=? WHERE record_id=?')
      .run(VOID_EXCLUSION_REASON, id)
    await expect(score(id, [], { unvoid: true })).rejects.toThrow('--note is required')
    await expect(
      score(id, ['full', 'right'], { unvoid: true }, { note: 'mistake' }),
    ).rejects.toThrow('--unvoid cannot be combined with a verdict')
    db().query("UPDATE run SET evidence_excluded='unjudged: owner gone' WHERE record_id=?").run(id)
    await expect(score(id, [], { unvoid: true }, { note: 'mistake' })).rejects.toThrow(
      "actual exclusion is 'unjudged: owner gone'",
    )
  })

  test('blocked-by-tree excludes routing evidence without recording a verdict', async () => {
    const kept = insert('ok', 'understand')
    const blocked = insert('ok', 'understand')
    seedScore(kept, 'full', 'right')
    await score(
      blocked,
      [],
      { 'blocked-by-tree': true },
      { note: 'the seeded database could not start' },
    )
    expect(db().query('SELECT evidence_excluded FROM run WHERE record_id=?').get(blocked)).toEqual({
      evidence_excluded: 'blocked by its tree: the seeded database could not start',
    })
    expect(db().query('SELECT * FROM score WHERE run_record_id=?').get(blocked)).toBeNull()
    expect(candidates('understand').find((row) => row.agent === 'codex')).toMatchObject({
      scored: 1,
      evidence: 1,
    })
  })

  test('void records its verdict but removes routing evidence', async () => {
    const outputPath = trackResidue(join(dir, 'voided-output.txt'))
    writeFileSync(outputPath, 'the retained answer')
    const id = insert('ok', 'review-lens')
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
      )
      .run(id, '2026-09-29', 'still relevant?')
    db().query('UPDATE run SET output_path=? WHERE record_id=?').run(outputPath, id)
    await score(id, ['none'], { void: true })
    expect(readFileSync(outputPath, 'utf8')).toBe('the retained answer')
    expect(db().query('SELECT evidence_excluded FROM run WHERE record_id=?').get(id)).toEqual({
      evidence_excluded: VOID_EXCLUSION_REASON,
    })
    expect(db().query('SELECT close_reason FROM question WHERE run_record_id=?').get(id)).toEqual({
      close_reason: 'chain-voided',
    })
    expect(db().query('SELECT delivery,quality FROM score WHERE run_record_id=?').get(id)).toEqual({
      delivery: 'none',
      quality: null,
    })
  })

  test('rolls back the exclusion when recording the verdict fails', async () => {
    const id = insert('ok', 'understand')
    db().exec(
      `CREATE TRIGGER reject_void_score BEFORE INSERT ON score WHEN NEW.run_record_id='${id}' BEGIN SELECT RAISE(ABORT,'fixture score refusal'); END`,
    )
    try {
      await expect(score(id, ['none'], { void: true })).rejects.toThrow('fixture score refusal')
    } finally {
      db().exec('DROP TRIGGER reject_void_score')
    }
    expect(db().query('SELECT evidence_excluded FROM run WHERE record_id=?').get(id)).toEqual({
      evidence_excluded: null,
    })
    expect(db().query('SELECT COUNT(*) n FROM score WHERE run_record_id=?').get(id)).toEqual({
      n: 0,
    })
  })

  test('says why a not-evidence failure verdict was not recorded', async () => {
    const id = insert('failed', 'understand')
    db().query("UPDATE run SET failure_kind='quota' WHERE record_id=?").run(id)
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
    expect(db().query('SELECT COUNT(*) n FROM score WHERE run_record_id=?').get(id)).toEqual({
      n: 0,
    })
  })

  test('refuses a foreign owner and permits an attributed unowned run', async () => {
    const owned = insert('ok', 'review-lens')
    db().query('UPDATE run SET session_id=? WHERE record_id=?').run('owner-session', owned)
    process.env.CLAUDE_CODE_SESSION_ID = 'foreign-session'
    await expect(score(owned, [], { void: true })).rejects.toThrow('owner-session')
    const unowned = insert('ok', 'review-lens')
    db().query('UPDATE run SET session_id=NULL WHERE record_id=?').run(unowned)
    process.env.CLAUDE_CODE_SESSION_ID = 'acting-session'
    await score(unowned, [], { void: true })
    expect(
      db()
        .query(
          'SELECT action,actor_session,reason FROM run_mutation_audit WHERE run_record_id=? ORDER BY rowid',
        )
        .all(unowned),
    ).toEqual([
      { action: 'adopt', actor_session: 'acting-session', reason: 'before void' },
      { action: 'void', actor_session: 'acting-session', reason: null },
    ])
  })
})
