import { describe, expect, test } from 'bun:test'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { judgeRun } from '../judgment.ts'
import { recordReviews } from './review.ts'
import { duplicateFindingRefusal, parseDuplicateFinding } from './review-duplicate-link.ts'
import { recordReview } from './review-triage.ts'

const judgmentFlags = (input: Record<string, string | string[]>) => ({
  has: (name: string) => input[name] !== undefined,
  flag: (name: string) => (typeof input[name] === 'string' ? (input[name] as string) : undefined),
  values: (name: string) =>
    Array.isArray(input[name]) ? (input[name] as string[]) : input[name] ? [input[name]] : [],
})

describe('duplicate finding links', () => {
  test('parses the score flag without constraining the run identifier shape', () => {
    expect(parseDuplicateFinding('2=42#3')).toEqual({
      ordinal: 2,
      otherRunId: '42',
      otherOrdinal: 3,
    })
    expect(() => parseDuplicateFinding('2:42#3')).toThrow('use N=<findings-run>')
  })

  test('accepts many links to one target and refuses relinking the scored finding', () => {
    const facts = {
      currentRunId: 'current',
      currentFindingId: 'finding-a',
      currentReviewId: 'review-a',
      currentTip: 'tip',
      otherRunId: 'other',
      otherFindingsJob: true,
      otherFindingId: 'finding-b',
      otherReviewId: 'review-b',
      otherTip: 'tip',
      currentDuplicateOfFindingId: null,
    }
    expect(duplicateFindingRefusal(facts)).toBeNull()
    expect(
      duplicateFindingRefusal({ ...facts, currentDuplicateOfFindingId: 'finding-b' }),
    ).toContain('scored finding is already linked')
    expect(duplicateFindingRefusal({ ...facts, currentFindingId: 'finding-b' })).toContain('itself')
  })

  test('refuses a non-findings run and a different review target with remedies', () => {
    const facts = {
      currentRunId: 'current',
      currentFindingId: 'finding-a',
      currentReviewId: 'review-a',
      currentTip: 'tip-a',
      otherRunId: 'other',
      otherFindingsJob: false,
      otherFindingId: 'finding-b',
      otherReviewId: 'review-b',
      otherTip: 'tip-b',
      currentDuplicateOfFindingId: null,
    }
    expect(duplicateFindingRefusal(facts)).toContain('name a run that produced review findings')
    expect(duplicateFindingRefusal({ ...facts, otherFindingsJob: true })).toContain(
      'same review or tip',
    )
  })

  test('scoring stores a same-tip link and enqueues it with the finding verdict', async () => {
    const session = process.env.CLAUDE_CODE_SESSION_ID ?? null
    const other = addRun({ agent: 'codex', job: 'review-lens', status: 'ok', session })
    const current = addRun({ agent: 'codex', job: 'review-lens', status: 'ok', session })
    for (const [run, model] of [
      [other, 'model-a'],
      [current, 'model-b'],
    ] as const) {
      db()
        .query("UPDATE run SET lens='correctness',model=?,head_commit='same-tip' WHERE record_id=?")
        .run(model, run)
      recordReview(run, reviewReply(run === current ? 2 : 1, 'high'), db())
    }

    await judgeRun(
      current,
      judgmentFlags({
        reproduced: 'all',
        coverage: 'adequate',
        limits: 'absent',
        overlap: 'shared',
        finding: ['1=accepted:high', '2=accepted:high'],
        duplicate: [`1=${other}#1`, `2=${other}#1`],
      }),
      { words: ['full', 'right'], note: null, auditReason: null, notEvidence: NOT_EVIDENCE },
      { log: () => {}, error: () => {}, pairHint: ({ id }) => id },
    )

    const peer = db()
      .query<{ record_id: string }, [string]>(
        `SELECT finding.record_id FROM review_finding finding
          JOIN review_lens lens ON lens.record_id=finding.review_lens_record_id
         WHERE lens.run_record_id=?`,
      )
      .get(other)!
    const payload = db()
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM outbox WHERE kind='review_finding'
          AND json_extract(payload,'$.duplicateOfFindingId') IS NOT NULL
          AND json_extract(payload,'$.reviewLensId')=(SELECT record_id FROM review_lens WHERE run_record_id=?)
          ORDER BY id DESC LIMIT 1`,
      )
      .get(current)!
    expect(JSON.parse(payload.payload).duplicateOfFindingId).toBe(peer.record_id)
    expect(
      db()
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM review_finding WHERE duplicate_of_finding_record_id=?',
        )
        .get(peer.record_id)!.count,
    ).toBe(2)
  })

  test('resolves review ordinals only when they belong to their named runs', async () => {
    const session = process.env.CLAUDE_CODE_SESSION_ID ?? null
    const other = addRun({ agent: 'codex', job: 'review-lens', status: 'ok', session })
    const current = addRun({ agent: 'codex', job: 'review-lens', status: 'ok', session })
    db().query("UPDATE run SET lens='correctness',model='model-a' WHERE record_id=?").run(other)
    db().query("UPDATE run SET lens='craft',model='model-b' WHERE record_id=?").run(current)
    recordReviews(
      [
        { runId: other, output: reviewReply(2, 'high') },
        { runId: current, output: reviewReply(1, 'medium') },
      ],
      db(),
    )

    await judgeRun(
      current,
      judgmentFlags({
        reproduced: 'all',
        coverage: 'adequate',
        limits: 'absent',
        overlap: 'shared',
        finding: ['1=accepted:high', '2=accepted:high', '3=accepted:medium'],
        duplicate: [`3=${other}#1`],
      }),
      { words: ['full', 'right'], note: null, auditReason: null, notEvidence: NOT_EVIDENCE },
      { log: () => {}, error: () => {}, pairHint: ({ id }) => id },
    )

    const rows = db()
      .query<{ ordinal: number; duplicate_ordinal: number | null }, [string]>(
        `SELECT finding.ordinal,duplicate.ordinal AS duplicate_ordinal
           FROM review_finding finding
           LEFT JOIN review_finding duplicate
             ON duplicate.record_id=finding.duplicate_of_finding_record_id
           JOIN review_lens lens ON lens.record_id=finding.review_lens_record_id
          WHERE lens.run_record_id=?`,
      )
      .all(current)
    expect(rows).toEqual([{ ordinal: 3, duplicate_ordinal: 1 }])
  })
})
