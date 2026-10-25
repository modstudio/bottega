import { describe, expect, spyOn, test } from 'bun:test'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { recordReviews } from './review.ts'
import { completeReview, gradeReviewLens, recordReview, triageFinding } from './review-triage.ts'

describe('review discipline', () => {
  test('copies the findings run role while defaulting legacy runs to round', () => {
    const supplementaryRun = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'm',
      lens: 'issue-blast-radius',
    })
    db().query("UPDATE run SET review_role='supplementary' WHERE record_id=?").run(supplementaryRun)
    const supplementary = recordReview(supplementaryRun, reviewReply(0), db())
    expect(db().query('SELECT role FROM review WHERE record_id=?').get(supplementary)).toEqual({
      role: 'supplementary',
    })

    const roundRun = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'm',
      lens: 'correctness-reviewer',
    })
    const round = recordReview(roundRun, reviewReply(0), db())
    expect(db().query('SELECT role FROM review WHERE record_id=?').get(round)).toEqual({
      role: 'round',
    })
  })

  test('refuses mixed round and supplementary batches in either input order', () => {
    const round = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'correctness' })
    const supplementary = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'm',
      lens: 'issue-blast-radius',
    })
    db().query("UPDATE run SET review_role='supplementary' WHERE record_id=?").run(supplementary)
    const entries = [
      { runId: round, output: reviewReply(0) },
      { runId: supplementary, output: reviewReply(0) },
    ]
    for (const ordered of [entries, [...entries].reverse()]) {
      expect(() => recordReviews(ordered)).toThrow(
        `record the round and supplementary runs separately with one ${PLATFORM_SLUG} review record command each`,
      )
    }
  })

  test('records each lens before triage and derives runner and model from the orchestrator run', () => {
    const first = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'effective-a',
      lens: 'safety',
    })
    const second = addRun({ agent: 'grok', job: 'craft', model: 'effective-b', lens: 'craft' })
    const review = recordReviews([
      { runId: first, output: reviewReply() },
      { runId: second, output: reviewReply(0) },
    ])
    const rows = db()
      .query(
        `SELECT rl.run_record_id, rl.lens, rl.agent, rl.model, r.completed_at
         FROM review_lens rl JOIN review r ON r.record_id=rl.review_record_id ORDER BY rl.run_record_id`,
      )
      .all() as {
      run_record_id: string
      lens: string
      agent: string
      model: string
      completed_at: string | null
    }[]
    expect(rows).toEqual([
      {
        run_record_id: first,
        lens: 'safety',
        agent: 'codex',
        model: 'effective-a',
        completed_at: null,
      },
      {
        run_record_id: second,
        lens: 'craft',
        agent: 'grok',
        model: 'effective-b',
        completed_at: null,
      },
    ])
    const identities = db()
      .query<{ record_id: string }, [string, string, string]>(
        `SELECT record_id FROM review WHERE record_id=?
         UNION ALL SELECT record_id FROM review_lens WHERE review_record_id=?
         UNION ALL SELECT record_id FROM review_finding WHERE review_record_id=?`,
      )
      .all(review, review, review)
    expect(identities.length).toBeGreaterThan(0)
    for (const row of identities) {
      expect(row.record_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    }
    expect(
      db()
        .query<{ kind: string; count: number }, [string, string, string]>(
          `SELECT kind, count(*) AS count FROM outbox
           WHERE row_id=(SELECT record_id FROM review WHERE record_id=?)
              OR row_id IN (SELECT record_id FROM review_lens WHERE review_record_id=?)
              OR row_id IN (SELECT record_id FROM review_finding WHERE review_record_id=?)
           GROUP BY kind ORDER BY kind`,
        )
        .all(review, review, review),
    ).toEqual(
      expect.arrayContaining([
        { kind: 'review', count: 1 },
        { kind: 'review_finding', count: 1 },
        { kind: 'review_lens', count: 2 },
      ]),
    )
    expect(() => completeReview(review)).toThrow('untriaged')
    triageFinding(review, 1, 'accepted')
    completeReview(review)
    expect(
      db().query('SELECT completed_at FROM review WHERE record_id=?').get(review) as {
        completed_at: string
      },
    ).toHaveProperty('completed_at')
  })
  test('a failed review insert rolls back both record rows and outbox rows', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'rollback' })
    const before = db().query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get()!
    db().exec(`CREATE TEMP TRIGGER fail_review_lens BEFORE INSERT ON review_lens
      BEGIN SELECT RAISE(ABORT, 'forced lens insert failure'); END`)
    try {
      expect(() => recordReview(runId, reviewReply(1), db())).toThrow('forced lens insert failure')
      expect(
        db().query('SELECT record_id FROM review_lens WHERE run_record_id=?').get(runId),
      ).toBeNull()
      expect(
        db().query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get(),
      ).toEqual(before)
    } finally {
      db().exec('DROP TRIGGER fail_review_lens')
    }
  })
  test('records orch-measured trees, refuses mixed measured content, and keeps claims optional', () => {
    const tree = '1111111111111111111111111111111111111111'
    const first = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'm',
      lens: 'one',
      inputTree: tree,
    })
    const second = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'm',
      lens: 'two',
      inputTree: tree,
    })
    const withoutClaim = reviewReply(0)
    delete (withoutClaim.provenance as Partial<typeof withoutClaim.provenance>).tree_inspected
    const review = recordReviews([
      { runId: first, output: withoutClaim },
      { runId: second, output: reviewReply(0) },
    ])
    expect(
      db()
        .query(
          'SELECT tree_inspected, reviewed_tree FROM review_lens WHERE review_record_id=? ORDER BY record_id',
        )
        .all(review),
    ).toEqual([
      { tree_inspected: null, reviewed_tree: tree },
      { tree_inspected: 'abc123', reviewed_tree: tree },
    ])

    const third = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'm',
      lens: 'three',
      inputTree: '2222222222222222222222222222222222222222',
    })
    expect(() =>
      recordReviews([
        { runId: third, output: reviewReply(0) },
        {
          runId: addRun({
            agent: 'codex',
            job: 'review-lens',
            model: 'm',
            lens: 'four',
            inputTree: '3333333333333333333333333333333333333333',
          }),
          output: reviewReply(0),
        },
      ]),
    ).toThrow(`run ${third}: 2222222222222222222222222222222222222222`)
  })
  test('stores dispatch selection reason and operator-ordered when metadata is absent', () => {
    const named = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'm',
      lens: 'correctness',
    })
    db().query("UPDATE run SET selection_reason='initial' WHERE record_id=?").run(named)
    const missing = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'craft' })
    recordReviews([
      { runId: named, output: reviewReply(0) },
      { runId: missing, output: reviewReply(0) },
    ])
    expect(
      db().query('SELECT lens, selection_reason FROM review_lens ORDER BY lens').all(),
    ).toEqual([
      { lens: 'correctness', selection_reason: 'initial' },
      { lens: 'craft', selection_reason: 'operator-ordered' },
    ])
  })
  test('an unregistered project warns after recording and does not block later grading', () => {
    const runId = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'm',
      lens: 'unregistered-pin',
      repo: 'not-registered',
      headCommit: 'a'.repeat(40),
      taskRecordId: newRecordId(),
      projectRecordId: null,
    })
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const reviewId = recordReview(runId, reviewReply(0), db())
      expect(reviewId).toMatch(/^[0-9a-f-]{36}$/)
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          `refs/orch/reviewed/${runId} was not created: project not-registered is not registered`,
        ),
      )
      expect(() =>
        gradeReviewLens(runId, null, {
          reproduced: 'none',
          coverage: 'adequate',
          limits: 'named',
          overlap: 'none',
        }),
      ).not.toThrow()
      expect(
        db().query('SELECT COUNT(*) AS n FROM review WHERE record_id=?').get(reviewId),
      ).toEqual({
        n: 1,
      })
    } finally {
      stderr.mockRestore()
    }
  })
  test('a findings run without a branch records the same change measurement as a branch run', () => {
    const repository = resolve(import.meta.dir, '../../..')
    db()
      .query(
        'INSERT INTO project (record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?)',
      )
      .run('measurement-fixture', repository, JSON.stringify({ trunk: 'main' }))
    const withoutBranch = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'm',
      lens: 'implicit',
      repo: 'measurement-fixture',
      headCommit: 'tip',
    })
    const withBranch = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'm',
      lens: 'explicit',
      repo: 'measurement-fixture',
      headCommit: 'tip',
    })
    db()
      .query(
        "UPDATE run SET project_record_id=(SELECT record_id FROM project WHERE name='measurement-fixture') WHERE record_id IN (?,?)",
      )
      .run(withoutBranch, withBranch)
    db().query("UPDATE run SET branch='DEV-977' WHERE record_id=?").run(withBranch)
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
      const args = command[1] === '-C' ? command.slice(3) : command.slice(1)
      let exitCode = 0
      let stdout = ''
      if (args[0] === 'show-ref') exitCode = 1
      else if (args.includes('--git-common-dir')) stdout = `${repository}/.git`
      else if (args[0] === 'rev-parse') stdout = 'base'
      else if (args[0] === 'merge-base') stdout = 'base'
      else if (args[0] === 'log') stdout = 'DEV-977 fixture'
      else if (args[0] === 'patch-id') stdout = 'same-patch commit'
      else if (args[0] === 'diff' && args.includes('--name-only')) stdout = 'src/change.ts'
      else if (args[0] === 'diff' && args.includes('--numstat')) stdout = '1\t0\tsrc/change.ts'
      else if (args[0] === 'diff') stdout = 'fixture patch'
      return {
        exitCode,
        stdout: Buffer.from(stdout),
        stderr: Buffer.from(''),
        success: exitCode === 0,
      } as unknown as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync)
    try {
      const implicitReview = recordReview(withoutBranch, reviewReply(0), db())
      const explicitReview = recordReview(withBranch, reviewReply(0), db())
      const measurement = (reviewId: string) =>
        db().query('SELECT patch_id, path_set, tier FROM review WHERE record_id=?').get(reviewId)

      expect(measurement(implicitReview)).toEqual(measurement(explicitReview))
      expect(measurement(implicitReview)).toEqual({
        patch_id: 'same-patch',
        path_set: '["src/change.ts"]',
        tier: 1,
      })
    } finally {
      spawn.mockRestore()
    }
  })
  test('a review without a repository or head commit keeps change measurement null', () => {
    const reviewId = recordReview(
      addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'unmeasured' }),
      reviewReply(0),
      db(),
    )

    expect(
      db().query('SELECT patch_id, path_set, tier FROM review WHERE record_id=?').get(reviewId),
    ).toEqual({ patch_id: null, path_set: null, tier: null })
  })
  test('triage records explicit severity agreement and leaves omission unassessed', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'severity' })
    const reviewId = recordReview(runId, reviewReply(2), db())
    db()
      .query("UPDATE review_finding SET severity='high' WHERE review_record_id=? AND ordinal=2")
      .run(reviewId)
    triageFinding(reviewId, 1, 'accepted', undefined, 'critical')
    triageFinding(reviewId, 2, 'modified', undefined, 'high')
    expect(
      db()
        .query(
          'SELECT ordinal, severity, triaged_severity FROM review_finding WHERE review_record_id=? ORDER BY ordinal',
        )
        .all(reviewId),
    ).toEqual([
      { ordinal: 1, severity: 'major', triaged_severity: 'critical' },
      { ordinal: 2, severity: 'high', triaged_severity: 'high' },
    ])
    expect(() => triageFinding(reviewId, 1, 'accepted', undefined, 'banana')).toThrow(
      'critical | high | medium | low',
    )
    expect(() =>
      db()
        .query("UPDATE review_finding SET triaged_severity='banana' WHERE review_record_id=?")
        .run(reviewId),
    ).toThrow()
  })
})
