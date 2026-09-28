import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { reconcileAbsentClaims } from './claim-reconciliation.ts'
import type { CleanupPresentation } from './cleanup.ts'

test('sweep dry-run lists absent and kept claims without changing either row', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const project = `claim-reconciliation-${runId}`
  upsertProject({ name: project, path: `/repo/${project}` })
  const projectId = (
    db().query('SELECT id FROM project WHERE name=?').get(project) as { id: number }
  ).id
  db()
    .query('UPDATE run SET repo=?,project_id=?,cwd=? WHERE id=?')
    .run(project, projectId, `/repo/${project}`, runId)
  const insert = db().query(
    `INSERT INTO resource_claim
     (root_run_id,run_id,project_id,kind,allocation_key,state,claimed_at)
     VALUES (?,?,?,'worktree',?,'claimed',?)`,
  )
  const absent = Number(
    insert.run(runId, runId, projectId, '/absent-tree', nowIso()).lastInsertRowid,
  )
  const present = Number(
    insert.run(runId, runId, projectId, '/present-tree', nowIso()).lastInsertRowid,
  )
  const lines: string[] = []
  const presentation: CleanupPresentation = {
    log: (...values) => lines.push(values.join(' ')),
    error: () => {},
    setExitCode: () => {},
    keptBranchLine: (branch) => branch,
  }

  reconcileAbsentClaims({
    dryRun: true,
    project,
    presentation,
    trust: { succeeded: true, headings: [] },
    database: db(),
    observers: {
      path: (path) => ({ outcome: path === '/present-tree' ? 'present' : 'absent' }),
      ref: () => ({ outcome: 'failed', detail: 'unused' }),
      trust: { succeeded: true, headings: [] },
      leaseState: () => 'missing',
      pidAlive: () => false,
    },
  })

  expect(lines).toEqual([
    `would settle absent claim ${absent} worktree /absent-tree`,
    `kept: claim ${present} worktree /present-tree: resource is present`,
  ])
  expect(db().query('SELECT id,state FROM resource_claim ORDER BY id').all()).toEqual([
    { id: absent, state: 'claimed' },
    { id: present, state: 'claimed' },
  ])
})

test('reconciling an absent worktree also settles its dependent port claim', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const project = `claim-cascade-${runId}`
  upsertProject({ name: project, path: `/repo/${project}` })
  const projectId = (
    db().query('SELECT id FROM project WHERE name=?').get(project) as { id: number }
  ).id
  db().query('UPDATE run SET repo=?,project_id=? WHERE id=?').run(project, projectId, runId)
  const insert = db().query(
    `INSERT INTO resource_claim
     (root_run_id,run_id,project_id,kind,allocation_key,state,claimed_at)
     VALUES (?,?,?,?,?,'claimed',?)`,
  )
  insert.run(runId, runId, projectId, 'worktree', '/absent-tree', nowIso())
  insert.run(runId, runId, projectId, 'port', '21991', nowIso())

  reconcileAbsentClaims({
    dryRun: false,
    project,
    presentation: { log: () => {}, error: () => {}, setExitCode: () => {}, keptBranchLine: String },
    trust: { succeeded: true, headings: [] },
    database: db(),
    observers: {
      path: () => ({ outcome: 'absent' }),
      ref: () => ({ outcome: 'failed', detail: 'unused' }),
      trust: { succeeded: true, headings: [] },
      leaseState: () => 'missing',
      pidAlive: () => false,
    },
    synchronize: (_row, reconcile) => reconcile(),
  })

  expect(
    db().query('SELECT kind,state FROM resource_claim WHERE root_run_id=? ORDER BY id').all(runId),
  ).toEqual([
    { kind: 'worktree', state: 'absent' },
    { kind: 'port', state: 'released' },
  ])
})

test('a guard that changes before locked settlement leaves the claim claimed', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const project = `claim-race-${runId}`
  upsertProject({ name: project, path: `/repo/${project}` })
  const projectId = (
    db().query('SELECT id FROM project WHERE name=?').get(project) as { id: number }
  ).id
  db().query('UPDATE run SET repo=?,project_id=? WHERE id=?').run(project, projectId, runId)
  const claimId = Number(
    db()
      .query(
        `INSERT INTO resource_claim
         (root_run_id,run_id,project_id,kind,allocation_key,state,claimed_at)
         VALUES (?,?,?,'worktree','/absent-tree','claimed',?)`,
      )
      .run(runId, runId, projectId, nowIso()).lastInsertRowid,
  )

  reconcileAbsentClaims({
    dryRun: false,
    project,
    presentation: { log: () => {}, error: () => {}, setExitCode: () => {}, keptBranchLine: String },
    trust: { succeeded: true, headings: [] },
    database: db(),
    observers: {
      path: () => ({ outcome: 'absent' }),
      ref: () => ({ outcome: 'failed', detail: 'unused' }),
      trust: { succeeded: true, headings: [] },
      leaseState: () => 'missing',
      pidAlive: () => false,
    },
    synchronize: (_row, reconcile) => {
      db().query("UPDATE run SET status='running' WHERE id=?").run(runId)
      reconcile()
    },
  })

  expect(db().query('SELECT state FROM resource_claim WHERE id=?').get(claimId)).toEqual({
    state: 'claimed',
  })
})

test('an unregistered missing worktree probes a present ref in its owning repository', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const repository = `/scratch/repository-${runId}`
  const worktree = `${repository}/.claude/worktrees/orch-${runId}`
  db()
    .query('UPDATE run SET repo=NULL,project_id=NULL,cwd=?,worktree=?,launch_cwd=? WHERE id=?')
    .run(worktree, worktree, repository, runId)
  const claimId = Number(
    db()
      .query(
        `INSERT INTO resource_claim
         (root_run_id,run_id,project_id,kind,allocation_key,state,claimed_at)
         VALUES (?, ?, NULL, 'branch', ?, 'claimed', ?)`,
      )
      .run(runId, runId, `refs/heads/DEV-991-${runId}`, nowIso()).lastInsertRowid,
  )
  const refRepositories: string[] = []

  reconcileAbsentClaims({
    dryRun: false,
    presentation: { log: () => {}, error: () => {}, setExitCode: () => {}, keptBranchLine: String },
    trust: { succeeded: true, headings: [] },
    database: db(),
    observers: {
      path: (path) => ({ outcome: path === repository ? 'present' : 'absent' }),
      ref: (path) => {
        refRepositories.push(path)
        return { outcome: 'present' }
      },
      trust: { succeeded: true, headings: [] },
      leaseState: () => 'missing',
      pidAlive: () => false,
    },
  })

  expect(refRepositories).toEqual([repository])
  expect(db().query('SELECT state FROM resource_claim WHERE id=?').get(claimId)).toEqual({
    state: 'claimed',
  })
})

test('an unregistered claim settles absent when its owning repository root is gone', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const repository = `/scratch/gone-repository-${runId}`
  const worktree = `${repository}/.claude/worktrees/orch-${runId}`
  db()
    .query('UPDATE run SET repo=NULL,project_id=NULL,cwd=?,worktree=?,launch_cwd=? WHERE id=?')
    .run(worktree, worktree, repository, runId)
  const claimId = Number(
    db()
      .query(
        `INSERT INTO resource_claim
         (root_run_id,run_id,project_id,kind,allocation_key,state,claimed_at)
         VALUES (?, ?, NULL, 'retained_ref', ?, 'claimed', ?)`,
      )
      .run(runId, runId, `refs/orch/retained/${runId}`, nowIso()).lastInsertRowid,
  )

  reconcileAbsentClaims({
    dryRun: false,
    presentation: { log: () => {}, error: () => {}, setExitCode: () => {}, keptBranchLine: String },
    trust: { succeeded: true, headings: [] },
    database: db(),
    observers: {
      path: () => ({ outcome: 'absent' }),
      ref: () => ({ outcome: 'failed', detail: 'repository is gone' }),
      trust: { succeeded: true, headings: [] },
      leaseState: () => 'missing',
      pidAlive: () => false,
    },
  })

  expect(
    db().query('SELECT state,settled_detail FROM resource_claim WHERE id=?').get(claimId),
  ).toEqual({
    state: 'absent',
    settled_detail: `observed absent repository ${repository}`,
  })
})
