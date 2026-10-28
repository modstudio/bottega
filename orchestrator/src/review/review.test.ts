import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db, sessionId } from '../database/db.ts'
import { cleanReviewEvidence, getReview, listReviews, UNEVIDENCED_REVIEW_ERROR } from './review.ts'
import { filesCoveredIntersectChanged } from './review-coverage-match.ts'
import { amendFinding, completeReview, recordReview, triageFinding } from './review-triage.ts'

describe('review listing', () => {
  test('lists populated reviews with display numbers and applies state and project filters', () => {
    db()
      .query("INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,'{}'),(?,?,?,'{}')")
      .run(
        '01990000-0000-7000-8000-000000000101',
        'listing-alpha',
        process.cwd(),
        '01990000-0000-7000-8000-000000000102',
        'listing-beta',
        process.cwd(),
      )
    const addReviewRun = (project: string, lens: string) => {
      const runId = addRun({
        agent: 'codex',
        job: 'review-lens',
        model: 'm',
        lens,
        repo: project,
      })
      db()
        .query(
          'UPDATE run SET project_record_id=(SELECT record_id FROM project WHERE name=?) WHERE record_id=?',
        )
        .run(project, runId)
      return runId
    }

    const openReview = recordReview(
      addReviewRun('listing-alpha', 'listing-open'),
      reviewReply(2, 'high'),
      db(),
    )
    triageFinding(openReview, 1, 'accepted', undefined, 'high', db())
    const completeReviewId = recordReview(
      addReviewRun('listing-alpha', 'listing-complete'),
      reviewReply(1, 'medium'),
      db(),
    )
    triageFinding(completeReviewId, 1, 'rejected', 'bogus', 'medium', db())
    completeReview(completeReviewId, db())
    const otherProjectReview = recordReview(
      addReviewRun('listing-beta', 'listing-other-project'),
      reviewReply(1, 'low'),
      db(),
    )

    const all = listReviews({}, db())
    expect(all).toHaveLength(3)
    expect(all.every((row) => row.record_id.length > 0 && row.number > 0)).toBe(true)
    expect(all.find((row) => row.record_id === openReview)?.findings).toEqual({
      total: 2,
      triaged: 1,
      accepted: 1,
      modified: 0,
      rejected: 0,
      skipped: 0,
    })
    expect(listReviews({ state: 'open' }, db()).map((row) => row.record_id)).toEqual([
      otherProjectReview,
      openReview,
    ])
    expect(listReviews({ state: 'complete' }, db()).map((row) => row.record_id)).toEqual([
      completeReviewId,
    ])
    expect(listReviews({ project: 'listing-alpha' }, db()).map((row) => row.record_id)).toEqual([
      openReview,
      completeReviewId,
    ])
  })
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
          'SELECT ordinal,triaged_severity FROM review_finding WHERE review_record_id=? ORDER BY ordinal',
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
          'SELECT disposition,triaged_severity,triaged_at FROM review_finding WHERE review_record_id=?',
        )
        .get(reviewId),
    ).toEqual({ disposition: null, triaged_severity: null, triaged_at: null })
  })

  test('a completed review finding can be amended with audit and fresh outbox rows', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'amend' })
    const reviewId = recordReview(runId, reviewReply(1, 'high'), db())
    triageFinding(reviewId, 1, 'rejected', 'bogus', undefined, db())
    completeReview(reviewId, db())
    const completed = db()
      .query<{ completed_at: string }, [string]>(
        'SELECT completed_at FROM review WHERE record_id=?',
      )
      .get(reviewId)!.completed_at
    db().query('DELETE FROM outbox').run()

    amendFinding(
      reviewId,
      1,
      'accepted',
      'Architect corrected the disposition',
      undefined,
      'medium',
      db(),
    )

    expect(getReview(reviewId, db()).findings[0]?.amendments).toEqual([
      {
        at: expect.any(String),
        actor_session: sessionId(),
        old_disposition: 'rejected',
        new_disposition: 'accepted',
        old_rejection_category: 'bogus',
        new_rejection_category: null,
        old_triaged_severity: null,
        new_triaged_severity: 'medium',
        reason: 'Architect corrected the disposition',
      },
    ])

    expect(
      db()
        .query(
          `SELECT disposition,rejection_category,triaged_severity
           FROM review_finding WHERE review_record_id=? AND ordinal=1`,
        )
        .get(reviewId),
    ).toEqual({ disposition: 'accepted', rejection_category: null, triaged_severity: 'medium' })
    expect(
      db()
        .query(
          `SELECT old_disposition,new_disposition,old_rejection_category,new_rejection_category,
                  old_triaged_severity,new_triaged_severity,reason,actor_session,at
           FROM review_finding_amendment amendment JOIN review_finding finding
             ON finding.record_id=amendment.review_finding_record_id
           WHERE finding.review_record_id=? AND finding.ordinal=1`,
        )
        .all(reviewId),
    ).toEqual([
      {
        old_disposition: 'rejected',
        new_disposition: 'accepted',
        old_rejection_category: 'bogus',
        new_rejection_category: null,
        old_triaged_severity: null,
        new_triaged_severity: 'medium',
        reason: 'Architect corrected the disposition',
        actor_session: sessionId(),
        at: expect.any(String),
      },
    ])
    expect(
      db()
        .query<{ record_id: string }, [string]>(
          `SELECT amendment.record_id FROM review_finding_amendment amendment
           JOIN review_finding finding ON finding.record_id=amendment.review_finding_record_id
           WHERE finding.review_record_id=?`,
        )
        .get(reviewId)?.record_id,
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(db().query('SELECT completed_at FROM review WHERE record_id=?').get(reviewId)).toEqual({
      completed_at: completed,
    })
    expect(
      db()
        .query<{ kind: string }, []>(
          "SELECT kind FROM outbox WHERE kind IN ('review','review_finding') ORDER BY id",
        )
        .all()
        .map((row) => row.kind),
    ).toEqual(['review_finding', 'review', 'review_finding'])
  })

  test('amendment refuses incomplete reviews, missing reasons, and rejected findings without category', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'amend-refusal' })
    const reviewId = recordReview(runId, reviewReply(1), db())
    expect(() =>
      amendFinding(reviewId, 1, 'accepted', 'correction', undefined, 'low', db()),
    ).toThrow(`review 1 is incomplete; use ${PLATFORM_SLUG} review triage 1 1`)
    triageFinding(reviewId, 1, 'accepted', undefined, 'low', db())
    completeReview(reviewId, db())
    expect(() => amendFinding(reviewId, 1, 'accepted', '   ', undefined, 'low', db())).toThrow(
      '--reason is required and must be non-empty',
    )
    expect(() =>
      amendFinding(reviewId, 1, 'rejected', 'correction', undefined, undefined, db()),
    ).toThrow('a rejected finding requires --category')
  })

  test('completed review triage refusal names the amend remedy', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'amend-remedy' })
    const reviewId = recordReview(runId, reviewReply(1), db())
    triageFinding(reviewId, 1, 'accepted', undefined, 'low', db())
    completeReview(reviewId, db())
    expect(() => triageFinding(reviewId, 1, 'modified', undefined, 'low', db())).toThrow(
      `use ${PLATFORM_SLUG} review amend 1 1`,
    )
  })
})

describe('review files_covered matching', () => {
  const changed = 'app/Http/Controllers/Foo.php'

  test('a placeholder finding with empty provenance is unevidenced', () => {
    const reply = reviewReply(1)
    reply.findings[0]!.evidence = 'prompt truncated, read the offloaded prompt'
    reply.provenance.files_covered = []
    reply.provenance.commands_run = []

    expect(cleanReviewEvidence('run-0', reply, db())).toEqual({
      failure: UNEVIDENCED_REVIEW_ERROR,
      note: null,
      kind: 'unevidenced',
    })
  })

  test('a placeholder finding with one covered file is accepted', () => {
    const reply = reviewReply(1)
    reply.findings[0]!.evidence = 'prompt truncated, read the offloaded prompt'
    reply.provenance.commands_run = []

    expect(cleanReviewEvidence('run-0', reply, db())).toEqual({ failure: null, note: null })
  })

  test('an existing file with a line and column location does not produce a note', () => {
    const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      stdout: 'pipe',
    })
      .stdout.toString()
      .trim()
    const runId = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'm',
      lens: 'finding-location',
      repo: 'run-fixture',
      inputTree: commit,
    })
    db().query('UPDATE run SET base_commit=? WHERE record_id=?').run(commit, runId)
    const reply = reviewReply(1)
    reply.findings[0]!.location = 'orchestrator/src/review/review.ts:114:7'

    expect(cleanReviewEvidence(runId, reply, db())).toEqual({ failure: null, note: null })
  })

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
