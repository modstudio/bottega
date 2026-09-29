import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { workerGateToolingCondition, workerGateToolingConditions } from './monitor-gate-tooling.ts'

test('worker gate tooling changes produce a run condition with paths and command', () => {
  expect(
    workerGateToolingCondition({
      runId: 73,
      startedAt: '2026-09-25T12:00:00.000Z',
      ownerSession: 'session-73',
      executions: [{ paths: ['package.json', 'scripts/gate'], command: 'bun run check' }],
      admitted: false,
      landed: false,
      branchExists: true,
    }),
  ).toEqual({
    kind: 'worker-gate-tooling-change',
    subject: 'run:73',
    since: '2026-09-25T12:00:00.000Z',
    ageMs: null,
    detail:
      'worker gate executed with changed tooling: paths package.json, scripts/gate; command bun run check',
    action: 'review those tooling changes before landing',
    ownerSession: 'session-73',
  })
  expect(
    workerGateToolingCondition({
      runId: 73,
      startedAt: '2026-09-25T12:00:00.000Z',
      ownerSession: null,
      executions: [{ paths: [], command: 'bun run check' }],
      admitted: false,
      landed: false,
      branchExists: true,
    }),
  ).toBeNull()
})

test('worker gate tooling changes clear only after admission, landing, or branch removal', () => {
  const facts = {
    runId: 73,
    startedAt: '2026-09-25T12:00:00.000Z',
    ownerSession: null,
    executions: [{ paths: ['package.json'], command: 'bun run check' }],
    admitted: false,
    landed: false,
    branchExists: true,
  }
  expect(workerGateToolingCondition({ ...facts, admitted: true })).toBeNull()
  expect(workerGateToolingCondition({ ...facts, landed: true })).toBeNull()
  expect(workerGateToolingCondition({ ...facts, branchExists: false })).toBeNull()
  expect(workerGateToolingCondition(facts)).toMatchObject({
    kind: 'worker-gate-tooling-change',
    action: 'review those tooling changes before landing',
  })
})

test('worker gate tooling admission must be at or after the latest tooling gate finished_at', () => {
  const database = db()
  const project = (
    database
      .query(
        `INSERT INTO project (name,path,stack,settings)
         VALUES ('fixture','/missing/fixture','bun','{"trunk":"main"}') RETURNING id`,
      )
      .get() as { id: number }
  ).id
  const before = addRun({ agent: 'codex', job: 'implement', repo: 'fixture' })
  const after = addRun({ agent: 'codex', job: 'implement', repo: 'fixture' })
  database
    .query('UPDATE run SET project_id=?,branch=?,minted_branch=? WHERE id=?')
    .run(project, 'DEV-before', 'DEV-before', before)
  database
    .query('UPDATE run SET project_id=?,branch=?,minted_branch=? WHERE id=?')
    .run(project, 'DEV-after', 'DEV-after', after)
  const insertGate = database.query(
    `INSERT INTO gate_execution
       (run_id,requested_at,started_at,finished_at,exit_code,tooling_paths,resolved_command)
     VALUES (?,'2026-09-25T11:59:00.000Z','2026-09-25T12:00:00.000Z',
             '2026-09-25T12:01:00.000Z',0,'["package.json"]','bun run check')`,
  )
  insertGate.run(before)
  insertGate.run(after)
  const insertSnapshot = database.query(
    `INSERT INTO landing_triage_snapshot
       (record_id,project,project_id,branch,tip,tree,review_ids,patch_id,tier,lens_rounds,
        finding_count,at)
     VALUES (?,?,?,?,?,'tree','[]','patch',1,1,0,?)`,
  )
  insertSnapshot.run(
    'snapshot-before',
    'fixture',
    project,
    'DEV-before',
    'before-tip',
    '2026-09-25T12:00:30.000Z',
  )
  insertSnapshot.run(
    'snapshot-after',
    'fixture',
    project,
    'DEV-after',
    'after-tip',
    '2026-09-25T12:01:30.000Z',
  )

  expect(workerGateToolingConditions(database).map((condition) => condition.subject)).toEqual([
    `run:${before}`,
  ])
})
