import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { readProjectReview, recordProjectReviewCommand } from './review-record-command.ts'
import type { ReviewRecordFindingsFile } from './review-record-findings.ts'

type Operations = NonNullable<Parameters<typeof recordProjectReviewCommand>[4]>

function operations(overrides: Partial<Operations> = {}): Operations {
  return {
    project: () => ({
      name: 'fixture',
      settings: {
        review: {
          lenses: [{ lens: 'correctness' }],
          record:
            'project-review record --tier {tier} --reason "{reason}" --agents {agents} --findings {findings} --branch {branch}',
        },
      },
    }),
    review: () => ({
      complete: true,
      tier: 2,
      rows: [
        {
          lens: 'correctness',
          run: 71,
          disposition: 'accepted',
          category: null,
          severity: 'high',
          location: 'src/a.ts:4',
        },
        {
          lens: 'craft',
          run: 72,
          disposition: 'skipped',
          category: null,
          severity: null,
          location: 'src/b.ts:9',
        },
      ],
    }),
    findingsPath: () => '/state/review.json',
    write: () => {},
    run: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    ...overrides,
  }
}

test('writes finished review findings and runs the declared argv in the requested tree', () => {
  let written: ReviewRecordFindingsFile | undefined
  let invocation: { argv: string[]; cwd: string } | undefined
  const reason = `correctness accepted; preserve "quoted" behavior`
  recordProjectReviewCommand(
    'DEV-1110-record',
    '/worktree',
    reason,
    { log() {} },
    {
      ...operations(),
      write: (_path, findings) => {
        written = findings
      },
      run: (argv, cwd) => {
        invocation = { argv, cwd }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  )

  expect(written).toEqual({
    lenses: ['correctness', 'craft'],
    findings: [
      {
        lens: 'correctness',
        verdict: 'accept',
        severity: 'high',
        location: 'src/a.ts:4',
        run: 71,
      },
    ],
    skipped: 1,
  })
  expect(invocation).toEqual({
    cwd: '/worktree',
    argv: [
      'project-review',
      'record',
      '--tier',
      '2',
      '--reason',
      reason,
      '--agents',
      '2',
      '--findings',
      '/state/review.json',
      '--branch',
      'DEV-1110-record',
    ],
  })
})

test('refuses incomplete triage with the judge remedy', () => {
  expect(() =>
    recordProjectReviewCommand(
      'DEV-1110-record',
      '/worktree',
      'correctness accepted',
      { log() {} },
      {
        ...operations(),
        review: () => ({ complete: false, tier: 2, rows: [] }),
      },
    ),
  ).toThrow(
    'review triage for DEV-1110-record is incomplete; finish every lens and finding with orch judge',
  )
})

test('a failed project command reports its output', () => {
  expect(() =>
    recordProjectReviewCommand(
      'DEV-1110-record',
      '/worktree',
      'correctness accepted',
      { log() {} },
      {
        ...operations(),
        run: () => ({ exitCode: 7, stdout: 'record stdout', stderr: 'record stderr' }),
      },
    ),
  ).toThrow(
    /record stdout\nrecord stderr\ncleared by: fix the project's review record command or its inputs/,
  )
})

test('selects only the current branch change and requires every selected lens to be graded and triaged', () => {
  const database = db()
  const addReview = (project: string, branch: string, lens: string, patchId: string) => {
    const run = addRun({ agent: 'codex', job: 'review-lens', lens, repo: project })
    database.query('UPDATE run SET branch=? WHERE id=?').run(branch, run)
    const review = database
      .query<{ id: number }, [string]>(
        `INSERT INTO review
           (recorded_at,completed_at,patch_id,path_set,tier)
         VALUES ('2026-10-09','2026-10-09',?,'["src/a.ts"]',2) RETURNING id`,
      )
      .get(patchId)!
    const reviewLens = database
      .query<{ id: number }, [number, number, string]>(
        `INSERT INTO review_lens
           (review_id,run_id,lens,agent,model,standards_read,files_covered,commands_run,
            could_not_verify,reproduced,coverage,limits,overlap)
         VALUES (?,?,?,'codex','model','[]','[]','[]','[]','all','adequate','absent','unique')
         RETURNING id`,
      )
      .get(review.id, run, lens)!
    database
      .query(
        `INSERT INTO review_finding
           (review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction,
            disposition,triaged_severity)
         VALUES (?,?,1,'high','src/a.ts:1','evidence','fix','accepted','high')`,
      )
      .run(review.id, reviewLens.id)
    return { review: review.id, lens: reviewLens.id, run }
  }

  const correctness = addReview('fixture', 'DEV-1246', 'correctness', 'target-patch')
  const craft = addReview('fixture', 'DEV-1246', 'craft', 'target-patch')
  addReview('fixture', 'DEV-other', 'distractor-branch', 'target-patch')
  addReview('other-project', 'DEV-1246', 'distractor-project', 'target-patch')

  const group = {
    project: 'fixture',
    branch: 'DEV-1246',
    patchId: 'target-patch',
    pathSet: ['src/a.ts'],
  }
  const selected = readProjectReview(database, group)
  expect(selected.complete).toBeTrue()
  expect(selected.rows.map(({ lens, run }) => ({ lens, run }))).toEqual([
    { lens: 'correctness', run: correctness.run },
    { lens: 'craft', run: craft.run },
  ])

  database
    .query('UPDATE review_finding SET disposition=NULL WHERE review_id=?')
    .run(correctness.review)
  expect(readProjectReview(database, group).complete).toBeFalse()

  database.query('DELETE FROM review_finding WHERE review_id=?').run(craft.review)
  database.query('UPDATE review_lens SET reproduced=NULL WHERE id=?').run(craft.lens)
  database
    .query("UPDATE review_finding SET disposition='accepted' WHERE review_id=?")
    .run(correctness.review)
  expect(readProjectReview(database, group).complete).toBeFalse()
})
