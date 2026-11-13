import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { landedTaskIdentities } from '../session/session-close-out-obligations.ts'
import {
  readBranchLandingTaskRows,
  readLandedReviewIds,
  resolveBranchLandingTaskKey,
} from './branch-landing-records.ts'

function fixture() {
  const database = migratedTestDatabase()
  const projectId = newRecordId()
  database
    .query(
      `INSERT INTO project (record_id,name,path,canon,settings)
       VALUES (?,'fixture','/fixture',0,'{"trunk":"main","keyPrefixes":["DEV"]}')`,
    )
    .run(projectId)
  const addRun = (recordId: string, branch: string | null, minted: string | null, key: string) =>
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,turn,
          project_record_id,branch,minted_branch,launch_key)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-11-09','codex','test','sha',1,
                 'head','ok',1,?,?,?,?)`,
      )
      .run(recordId, projectId, branch, minted, key)
  const addLanding = (branch: string, session: string) =>
    database
      .query(
        `INSERT INTO branch_landing_record
         (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recorded_at,recording_session)
         VALUES (?,'fixture',?,?, 'tip',1,'merge','2026-11-09','2026-11-09',?)`,
      )
      .run(newRecordId(), projectId, branch, session)
  return { database, addRun, addLanding }
}

test('landing task reader carries minted and branch run key relations', () => {
  const { database, addRun, addLanding } = fixture()
  addRun('minted-run', null, 'minted-landing', 'DEV-1')
  addRun('branch-run', 'branch-landing', null, 'DEV-2')
  addLanding('minted-landing', 'other')
  addLanding('branch-landing', 'closing')

  const rows = readBranchLandingTaskRows(database)
  expect(rows.find((row) => row.branch === 'minted-landing')).toEqual({
    project: 'fixture',
    branch: 'minted-landing',
    recordingSession: 'other',
    runRecordId: 'minted-run',
    mintedTaskKey: 'DEV-1',
    branchTaskKey: null,
  })
  expect(rows.find((row) => row.branch === 'branch-landing')).toEqual({
    project: 'fixture',
    branch: 'branch-landing',
    recordingSession: 'closing',
    runRecordId: null,
    mintedTaskKey: null,
    branchTaskKey: 'DEV-2',
  })
})

test('landed review ids include only snapshots for merged pull requests', () => {
  const { database } = fixture()
  const projectId = database
    .query<{ record_id: string }, []>("SELECT record_id FROM project WHERE name='fixture'")
    .get()!.record_id
  const addSnapshot = (recordId: string, branch: string, prNumber: number, reviews: string[]) =>
    database
      .query(
        `INSERT INTO landing_triage_snapshot
         (record_id,project,project_record_id,branch,tip,tree,pr_number,review_record_ids,patch_id,
          tier,lens_rounds,finding_count,at)
         VALUES (?,'fixture',?,?,?,'tree',?,?,'patch',1,1,0,'2026-11-09')`,
      )
      .run(recordId, projectId, branch, recordId, prNumber, JSON.stringify(reviews))
  const addPullRequest = (branch: string, prNumber: number) =>
    database
      .query(
        `INSERT INTO branch_landing_record
         (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
         VALUES (?,'fixture',?,?,'tip',?,'merge',?,'2026-11-09')`,
      )
      .run(newRecordId(), projectId, branch, prNumber, '2026-11-09')

  addSnapshot('merged-snapshot', 'merged-branch', 1, ['review-merged-a', 'review-merged-b'])
  addPullRequest('merged-branch', 1)
  addSnapshot('open-snapshot', 'open-branch', 2, ['review-open'])
  addSnapshot('other-pr-snapshot', 'merged-branch', 2, ['review-other-pr'])

  expect(readLandedReviewIds(database, 'fixture')).toEqual(
    new Set(['review-merged-a', 'review-merged-b']),
  )
})

test('landing key resolution honors run order and registered branch prefixes', () => {
  expect(
    resolveBranchLandingTaskKey(
      { branch: 'worktree-DEV-3', mintedTaskKey: 'DEV-1', branchTaskKey: 'DEV-2' },
      ['DEV'],
    ),
  ).toBe('DEV-1')
  expect(
    resolveBranchLandingTaskKey(
      { branch: 'worktree-dev-2016-extra', mintedTaskKey: null, branchTaskKey: null },
      ['DEV'],
    ),
  ).toBe('DEV-2016')
  expect(
    resolveBranchLandingTaskKey(
      { branch: 'worktree-other-2016-extra', mintedTaskKey: null, branchTaskKey: null },
      ['DEV'],
    ),
  ).toBeNull()
})

test('landing identities filter by recording session or owned minting run and deduplicate', () => {
  const { database, addRun, addLanding } = fixture()
  addRun('owned-run', null, 'owned-branch', 'DEV-10')
  addRun('other-run', null, 'recorded-branch', 'DEV-11')
  addRun('unrelated-run', null, 'unrelated-branch', 'DEV-12')
  addLanding('owned-branch', 'other')
  addLanding('recorded-branch', 'closing')
  addLanding('unrelated-branch', 'other')
  addLanding('worktree-dev-13-extra', 'closing')

  expect(
    landedTaskIdentities({
      session: 'closing',
      ownedRunRecordIds: new Set(['owned-run']),
      rows: readBranchLandingTaskRows(database),
      keyPrefixesByProject: new Map([['fixture', ['DEV']]]),
    }),
  ).toEqual([
    { project: 'fixture', taskKey: 'DEV-10' },
    { project: 'fixture', taskKey: 'DEV-11' },
    { project: 'fixture', taskKey: 'DEV-13' },
  ])
})
