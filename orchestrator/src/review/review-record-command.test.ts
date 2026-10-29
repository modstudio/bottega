import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  emptyProjectReviewRefusal,
  readProjectReview,
  recordProjectReviewCommand,
  reviewRecordCommandOperations,
} from './review-record-command.ts'
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
          run: 'run-record-id-71',
          disposition: 'accepted',
          category: null,
          severity: 'high',
          location: 'src/a.ts:4',
        },
        {
          lens: 'craft',
          run: 'run-record-id-72',
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
        run: 'run-record-id-71',
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
    `review triage for DEV-1110-record is incomplete; finish every lens and finding with ${PLATFORM_SLUG} score`,
  )
})

test('refuses an empty lineage when completed same-task rounds are on other branches', () => {
  const refusal = emptyProjectReviewRefusal({
    selectedReviewCount: 0,
    taskKey: 'DEV-1852',
    lineage: ['current-fix', 'original-fix'],
    completedReviewBranches: ['reviewed-a', 'reviewed-b'],
  })
  expect(refusal).toContain('review lineage [current-fix, original-fix] selected no review rounds')
  expect(refusal).toContain('task DEV-1852')
  expect(refusal).toContain('branches [reviewed-a, reviewed-b]')

  expect(
    emptyProjectReviewRefusal({
      selectedReviewCount: 0,
      taskKey: 'DEV-1852',
      lineage: ['current-fix'],
      completedReviewBranches: [],
    }),
  ).toBeNull()
})

test('project-record carries a real store refusal to the operator before writing', () => {
  const database = db()
  const cwd = mkdtempSync(join(tmpdir(), 'review-project-record-'))
  const git = (...argv: string[]) => {
    const result = Bun.spawnSync(['git', ...argv], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  try {
    git('init', '-b', 'main')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.test')
    writeFileSync(join(cwd, 'a.ts'), 'base\n')
    git('add', 'a.ts')
    git('commit', '-m', 'base')
    git('checkout', '-b', 'current-fix')
    writeFileSync(join(cwd, 'a.ts'), 'base\nchange\n')
    git('add', 'a.ts')
    git('commit', '-m', 'change')

    const projectId = newRecordId()
    database.query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)').run(
      projectId,
      'fixture-record-command',
      cwd,
      JSON.stringify({
        trunk: 'main',
        review: {
          lenses: [{ lens: 'correctness' }],
          record: 'project-review record --findings {findings}',
        },
      }),
    )
    const current = addRun({
      agent: 'codex',
      job: 'implement',
      repo: 'fixture-record-command',
      projectRecordId: projectId,
    })
    const reviewed = addRun({
      agent: 'codex',
      job: 'review-lens',
      repo: 'fixture-record-command',
      projectRecordId: projectId,
    })
    database
      .query("UPDATE run SET branch='current-fix',launch_key='DEV-1852' WHERE record_id=?")
      .run(current)
    database
      .query("UPDATE run SET branch='reviewed-elsewhere',launch_key='DEV-1852' WHERE record_id=?")
      .run(reviewed)
    const reviewId = newRecordId()
    database
      .query(
        `INSERT INTO review
           (record_id,number,recorded_at,completed_at,project_record_id,patch_id,path_set,tier,role)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),'2026-10-29','2026-10-29',?,
                 'reviewed-patch','["a.ts"]',2,'round')`,
      )
      .run(reviewId, projectId)
    database
      .query(
        `INSERT INTO review_lens
           (record_id,review_record_id,run_record_id,lens,agent,model,standards_read,files_covered,commands_run,could_not_verify)
         VALUES (?,?,?,'correctness','codex','model','[]','[]','[]','[]')`,
      )
      .run(newRecordId(), reviewId, reviewed)

    let writes = 0
    let runs = 0
    expect(() =>
      recordProjectReviewCommand(
        'current-fix',
        cwd,
        'record reviewed change',
        { log() {} },
        {
          ...reviewRecordCommandOperations(database),
          write: () => {
            writes += 1
          },
          run: () => {
            runs += 1
            return { exitCode: 0, stdout: '', stderr: '' }
          },
        },
      ),
    ).toThrow(
      /review lineage \[current-fix\] selected no review rounds for task DEV-1852.*branches \[reviewed-elsewhere\]/,
    )
    expect({ writes, runs }).toEqual({ writes: 0, runs: 0 })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('project review store detects completed same-task rounds outside the searched lineage', () => {
  const database = db()
  database
    .query("INSERT OR IGNORE INTO project (record_id,name,path,settings) VALUES (?,?,?,'{}')")
    .run(newRecordId(), 'fixture', '/fixture/fixture')
  const current = addRun({ agent: 'codex', job: 'implement', repo: 'fixture' })
  const reviewed = addRun({ agent: 'codex', job: 'review-lens', repo: 'fixture' })
  database
    .query(
      `UPDATE run SET branch='current-fix',minted_branch='current-fix',launch_key='DEV-1852',
              project_record_id=(SELECT record_id FROM project WHERE name='fixture')
        WHERE record_id=?`,
    )
    .run(current)
  database
    .query(
      `UPDATE run SET branch='reviewed-elsewhere',launch_key='DEV-1852',
              project_record_id=(SELECT record_id FROM project WHERE name='fixture')
        WHERE record_id=?`,
    )
    .run(reviewed)
  const reviewId = newRecordId()
  database
    .query(
      `INSERT INTO review (record_id,number,recorded_at,completed_at,project_record_id,patch_id,path_set,tier,role)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),'2026-10-29','2026-10-29',
               (SELECT record_id FROM project WHERE name='fixture'),
               'reviewed-patch','["src/a.ts"]',2,'round')`,
    )
    .run(reviewId)
  database
    .query(
      `INSERT INTO review_lens
         (record_id,review_record_id,run_record_id,lens,agent,model,standards_read,files_covered,commands_run,could_not_verify)
       VALUES (?,?,?,'correctness','codex','model','[]','[]','[]','[]')`,
    )
    .run(newRecordId(), reviewId, reviewed)

  const selected = readProjectReview(database, {
    project: 'fixture',
    branch: 'current-fix',
    patchId: 'current-patch',
    pathSet: ['src/a.ts'],
  })
  expect(selected.rows).toEqual([])
  expect(selected.refusal).toContain('review lineage [current-fix]')
  expect(selected.refusal).toContain('branches [reviewed-elsewhere]')
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

test('selects every review round on the branch and requires every selected lens to be graded and triaged', () => {
  const database = db()
  const addReview = (project: string, branch: string, lens: string, patchId: string) => {
    database
      .query("INSERT OR IGNORE INTO project (record_id,name,path,settings) VALUES (?,?,?,'{}')")
      .run(newRecordId(), project, `/fixture/${project}`)
    const run = addRun({ agent: 'codex', job: 'review-lens', lens, repo: project })
    database
      .query(
        'UPDATE run SET branch=?,project_record_id=(SELECT record_id FROM project WHERE name=?) WHERE record_id=?',
      )
      .run(branch, project, run)
    const review = database
      .query<{ record_id: string }, [string, string]>(
        `INSERT INTO review
           (record_id,number,recorded_at,completed_at,patch_id,path_set,tier)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),'2026-10-09','2026-10-09',?,'["src/a.ts"]',2) RETURNING record_id`,
      )
      .get(newRecordId(), patchId)!
    const reviewLens = database
      .query<{ record_id: string }, [string, string, string, string]>(
        `INSERT INTO review_lens
           (record_id,review_record_id,run_record_id,lens,agent,model,standards_read,files_covered,commands_run,
            could_not_verify,reproduced,coverage,limits,overlap)
         VALUES (?,?,?,?,'codex','model','[]','[]','[]','[]','all','adequate','absent','unique')
         RETURNING record_id`,
      )
      .get(newRecordId(), review.record_id, run, lens)!
    database
      .query(
        `INSERT INTO review_finding
           (record_id,review_record_id,review_lens_record_id,ordinal,severity,location,evidence,proposed_correction,
            disposition,triaged_severity)
         VALUES (?,?,?,1,'high','src/a.ts:1','evidence','fix','accepted','high')`,
      )
      .run(newRecordId(), review.record_id, reviewLens.record_id)
    return { review: review.record_id, lens: reviewLens.record_id, run }
  }

  const correctness = addReview('fixture', 'DEV-1246', 'correctness', 'earlier-patch')
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
    .query('UPDATE review_finding SET disposition=NULL WHERE review_record_id=?')
    .run(correctness.review)
  expect(readProjectReview(database, group).complete).toBeFalse()

  database.query('DELETE FROM review_finding WHERE review_record_id=?').run(craft.review)
  database.query('UPDATE review_lens SET reproduced=NULL WHERE record_id=?').run(craft.lens)
  database
    .query("UPDATE review_finding SET disposition='accepted' WHERE review_record_id=?")
    .run(correctness.review)
  expect(readProjectReview(database, group).complete).toBeFalse()
})
