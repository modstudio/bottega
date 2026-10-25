import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { loadCycleCostReport } from './cycle-cost-service.ts'

test('loads branch attribution, ambiguity, retired projects, and incomplete CI', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  const activeId = '01990000-0000-7000-8000-000000000101'
  const retiredId = '01990000-0000-7000-8000-000000000102'
  const unregisteredId = '01990000-0000-7000-8000-000000000103'
  database
    .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(activeId, 'active-fixture', '/active-fixture', JSON.stringify({ keyPrefixes: ['DEV'] }))
  database
    .query('INSERT INTO project (record_id,name,path,settings,retired_at) VALUES (?,?,?,?,?)')
    .run(
      retiredId,
      'retired-fixture',
      '/retired-fixture',
      JSON.stringify({ keyPrefixes: ['OLD'] }),
      '2026-10-01T00:00:00Z',
    )

  const insertRun = database.query(
    `INSERT INTO run
      (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,
       project_record_id,launch_key,branch,minted_branch,turn)
     VALUES (?,?,?,?,?,'sha',1,'prompt',?,?,?,?,1)`,
  )
  insertRun.run(
    '01990000-0000-7000-8000-000000000201',
    1,
    '2026-10-09T00:00:00Z',
    'codex',
    'implement',
    activeId,
    'DEV-1',
    'feature-one',
    'different-minted-branch',
  )
  insertRun.run(
    '01990000-0000-7000-8000-000000000202',
    2,
    '2026-10-09T00:00:00Z',
    'codex',
    'implement',
    activeId,
    'DEV-3',
    'DEV-2-conflict',
    'DEV-2-conflict',
  )
  database
    .query("UPDATE run SET lens='issue-blast-radius' WHERE record_id=?")
    .run('01990000-0000-7000-8000-000000000201')
  const supplementaryReviewId = '01990000-0000-7000-8000-000000000211'
  database
    .query(
      `INSERT INTO review(record_id,number,recorded_at,completed_at,tier,role,patch_id,path_set,project_record_id)
       VALUES (?,1,'2026-10-09T00:00:00Z','2026-10-09T01:00:00Z',1,'supplementary','patch','[]',?)`,
    )
    .run(supplementaryReviewId, activeId)
  database
    .query(
      `INSERT INTO review_lens(record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
       VALUES ('01990000-0000-7000-8000-000000000212',?,?,'issue-blast-radius','codex','[]','[]','[]','[]')`,
    )
    .run(supplementaryReviewId, '01990000-0000-7000-8000-000000000201')

  const insertLanding = database.query(
    `INSERT INTO branch_landing_record
      (project,project_record_id,branch,tip,pr_number,merged_at,recorded_at,record_id)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
  insertLanding.run(
    'active-fixture',
    activeId,
    'feature-one',
    'tip-1',
    11,
    '2026-10-10T00:00:00Z',
    '2026-10-10T00:00:00Z',
    '01990000-0000-7000-8000-000000000301',
  )
  insertLanding.run(
    'active-fixture',
    activeId,
    'DEV-2-conflict',
    'tip-2',
    12,
    '2026-10-11T00:00:00Z',
    '2026-10-11T00:00:00Z',
    '01990000-0000-7000-8000-000000000302',
  )
  insertLanding.run(
    'retired-fixture',
    retiredId,
    'OLD-1-retired',
    'tip-3',
    13,
    '2026-10-12T00:00:00Z',
    '2026-10-12T00:00:00Z',
    '01990000-0000-7000-8000-000000000303',
  )
  database.run('PRAGMA foreign_keys = OFF')
  insertLanding.run(
    'removed-fixture',
    unregisteredId,
    'DEV-4-removed',
    'tip-4',
    14,
    '2026-10-13T00:00:00Z',
    '2026-10-13T00:00:00Z',
    '01990000-0000-7000-8000-000000000304',
  )
  insertLanding.run(
    'missing-identity-fixture',
    null,
    'DEV-5-missing-identity',
    'tip-5',
    15,
    '2026-10-14T00:00:00Z',
    '2026-10-14T00:00:00Z',
    '01990000-0000-7000-8000-000000000305',
  )
  database.run('PRAGMA foreign_keys = ON')
  database
    .query(
      `INSERT INTO pull_request_ci
        (record_id,project,project_record_id,pr_number,record_kind,complete,recorded_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      '01990000-0000-7000-8000-000000000401',
      'active-fixture',
      activeId,
      11,
      'collection',
      0,
      '2026-10-10T00:00:00Z',
    )

  const report = loadCycleCostReport(database, {
    currentWindow: { start: '2026-10-08T00:00:00Z', end: '2026-10-15T00:00:00Z' },
    previousWindow: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' },
  })

  expect(report.current.tasks.map((task) => [task.project, task.taskKey])).toEqual([
    ['active-fixture', 'DEV-1'],
    ['retired-fixture', 'OLD-1'],
  ])
  expect(report.current.tasks[0]?.dispatchToMergeHours).toBe(24)
  expect(report.current.tasks[0]?.ciRuns).toBeNull()
  expect(report.current.tasks[0]?.reviewRounds).toBe(0)
  expect(report.current.aggregates.unknownCiTasks).toBe(2)
  expect(report.current.unattributedLandings).toEqual([
    {
      project: 'active-fixture',
      branch: 'DEV-2-conflict',
      pullRequestNumber: 12,
      reason: 'could not establish one task key; found DEV-3, DEV-2',
    },
    {
      project: 'removed-fixture',
      branch: 'DEV-4-removed',
      pullRequestNumber: 14,
      reason: 'project not registered',
    },
    {
      project: 'missing-identity-fixture',
      branch: 'DEV-5-missing-identity',
      pullRequestNumber: 15,
      reason: 'missing project identity',
    },
  ])
  database.close()
})
