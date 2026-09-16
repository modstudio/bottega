import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { reviewReply } from '../test/fixtures/replies.ts'
import { addRun } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { newRecordId } from './postgres-schema.ts'
import { recordReviewCarry } from './review.ts'
import { filesCoveredIntersectChanged } from './review-coverage-match.ts'
import { recordReview, triageFinding } from './review-triage.ts'

test('recording a carried review enqueues the carry in the same write path', () => {
  const review = db()
    .query(
      "INSERT INTO review (record_id,recorded_at) VALUES (?,'2026-09-15T00:00:00Z') RETURNING id",
    )
    .get(newRecordId()) as { id: number }
  recordReviewCarry({
    project: 'fixture',
    branch: 'DEV-597-orch-4145',
    tip: 'tip',
    tree: 'tree',
    reviewId: review.id,
    reviewedCommit: 'commit',
    reviewedTree: 'reviewed-tree',
    patchId: 'patch',
    oldBase: 'old',
    newBase: 'new',
  })
  const carry = db()
    .query<{ record_id: string }, []>(
      'SELECT record_id FROM landing_review_carry ORDER BY id DESC LIMIT 1',
    )
    .get()!
  expect(
    db()
      .query<{ kind: string }, [string]>(
        "SELECT kind FROM outbox WHERE kind='landing_review_carry' AND record_id=?",
      )
      .get(carry.record_id),
  ).toEqual({ kind: 'landing_review_carry' })
})

describe('review triage', () => {
  test('review triage --severity stores explicit agreement and omission stores null', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'triage' })
    const reviewId = recordReview(runId, reviewReply(2, 'high'), db())
    triageFinding(reviewId, 1, 'accepted', undefined, 'high', db())
    expect(
      db().query<{ kind: string }, []>('SELECT kind FROM outbox ORDER BY id DESC LIMIT 1').get(),
    ).toEqual({ kind: 'review_finding' })
    triageFinding(reviewId, 2, 'accepted', undefined, undefined, db())
    expect(
      db()
        .query(
          'SELECT ordinal,triaged_severity FROM review_finding WHERE review_id=? ORDER BY ordinal',
        )
        .all(reviewId),
    ).toEqual([
      { ordinal: 1, triaged_severity: 'high' },
      { ordinal: 2, triaged_severity: null },
    ])
    expect(() => triageFinding(reviewId, 2, 'accepted', undefined, 'banana', db())).toThrow(
      'critical | high | medium | low',
    )
  })

  test('duplicate triage severity is refused without changing the finding', () => {
    const runId = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'm',
      lens: 'triage-duplicate',
    })
    const reviewId = recordReview(runId, reviewReply(1), db())
    expect(() => triageFinding(reviewId, 1, 'accepted', undefined, 'banana', db())).toThrow(
      'severity must be',
    )
    expect(
      db()
        .query(
          'SELECT disposition,triaged_severity,triaged_at FROM review_finding WHERE review_id=?',
        )
        .get(reviewId),
    ).toEqual({ disposition: null, triaged_severity: null, triaged_at: null })
  })
})

describe('review files_covered matching', () => {
  const changed = 'app/Http/Controllers/Foo.php'

  test('an absolute worktree path ending in a changed path counts as coverage', () => {
    expect(
      filesCoveredIntersectChanged(
        [changed],
        [
          '/Users/shmuel/Projects/starship/.claude/worktrees/orch-3841/app/Http/Controllers/Foo.php',
        ],
      ),
    ).toBe(true)
  })

  test('an annotated entry naming a changed path counts as coverage', () => {
    expect(
      filesCoveredIntersectChanged(
        [changed],
        ['2 of 2 changed files inspected in full: app/Http/Controllers/Foo.php'],
      ),
    ).toBe(true)
  })

  test('a subdirectory-relative suffix still counts as coverage', () => {
    expect(filesCoveredIntersectChanged(['orchestrator/src/review.ts'], ['src/review.ts'])).toBe(
      true,
    )
  })

  test('empty files_covered is unevidenced', () => {
    expect(filesCoveredIntersectChanged([changed], [])).toBe(false)
  })

  test('an entry naming only an unchanged path is unevidenced', () => {
    expect(filesCoveredIntersectChanged([changed], ['README.md'])).toBe(false)
  })

  test('a path that only shares a basename with a changed path does not count', () => {
    expect(filesCoveredIntersectChanged(['app/X.php'], ['other/X.php'])).toBe(false)
  })

  test('a space-containing changed path listed as a whole entry counts as coverage', () => {
    expect(
      filesCoveredIntersectChanged(['dir with space/file.ts'], ['dir with space/file.ts']),
    ).toBe(true)
  })

  test('cleanReviewEvidence uses filesCoveredIntersectChanged', () => {
    const source = readFileSync(new URL('./review.ts', import.meta.url), 'utf8')
    expect(source).toContain("from './review-coverage-match.ts'")
    expect(source).toContain('filesCoveredIntersectChanged(changed, provenance.files_covered)')
  })
})
