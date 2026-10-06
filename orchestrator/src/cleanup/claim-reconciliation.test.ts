import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { reconcileAbsentClaims } from './claim-reconciliation.ts'
import type { CleanupPresentation } from './cleanup.ts'

function keptBranchClaim(tip: string | null = 'a'.repeat(40)) {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const project = `kept-branch-claim-${runId}`
  const repository = `/repo/${project}`
  const branch = `DEV-1128-orch-${runId}`
  const ref = `refs/heads/${branch}`
  upsertProject({ name: project, path: repository })
  const projectId = (
    db().query('SELECT id FROM project WHERE name=?').get(project) as { id: number }
  ).id
  db()
    .query('UPDATE run SET repo=?,project_id=?,cwd=?,branch_kept=?,branch_kept_tip=? WHERE id=?')
    .run(project, projectId, repository, branch, tip, runId)
  const claimId = Number(
    db()
      .query(
        `INSERT INTO resource_claim
         (root_run_id,run_id,project_id,kind,allocation_key,state,claimed_at)
         VALUES (?,?,?,'branch',?,'claimed',?)`,
      )
      .run(runId, runId, projectId, ref, nowIso()).lastInsertRowid,
  )
  return { runId, project, repository, branch, ref, claimId, tip }
}

function markKeptOnAnotherTurn(tip: string | null) {
  const fixture = keptBranchClaim()
  db().query('UPDATE run SET branch_kept=NULL,branch_kept_tip=NULL WHERE id=?').run(fixture.runId)
  const keptTurnId = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    parent: fixture.runId,
    turn: 2,
  })
  db()
    .query('UPDATE run SET branch_kept=?,branch_kept_tip=? WHERE id=?')
    .run(fixture.branch, tip, keptTurnId)
  return { ...fixture, tip, keptTurnId }
}

function linePresentation(lines: string[]): CleanupPresentation {
  return {
    log: (...values) => lines.push(values.join(' ')),
    error: () => {},
    setExitCode: () => {},
    keptBranchLine: String,
  }
}

function claimState(claimId: number) {
  return db().query('SELECT state,settled_detail FROM resource_claim WHERE id=?').get(claimId) as {
    state: string
    settled_detail: string | null
  }
}

test('an absent kept branch with a live tip is restored once and settled retained', () => {
  const fixture = keptBranchClaim()
  const restored: string[] = []
  const lines: string[] = []

  reconcileAbsentClaims({
    dryRun: false,
    project: fixture.project,
    presentation: linePresentation(lines),
    trust: { succeeded: true, headings: [] },
    database: db(),
    observers: {
      ref: () => ({ outcome: 'absent' }),
      commit: () => ({ outcome: 'present' }),
      restoreBranch: (_repository, branch, tip) => {
        restored.push(`${branch}@${tip}`)
        return { ok: true }
      },
      leaseState: () => 'missing',
      pidAlive: () => false,
    },
    synchronize: (_row, reconcile) => reconcile(),
  })

  expect(restored).toEqual([`${fixture.branch}@${fixture.tip}`])
  expect(claimState(fixture.claimId)).toEqual({
    state: 'retained',
    settled_detail: `branch retained at ${fixture.tip}`,
  })
  expect(lines).toEqual([`restored ${fixture.branch} at ${fixture.tip}`])
})

test("a kept branch recorded by another turn is restored at that turn's tip", () => {
  const fixture = markKeptOnAnotherTurn('d'.repeat(40))
  const restored: string[] = []

  reconcileAbsentClaims({
    dryRun: false,
    project: fixture.project,
    presentation: linePresentation([]),
    trust: { succeeded: true, headings: [] },
    database: db(),
    observers: {
      ref: () => ({ outcome: 'absent' }),
      commit: () => ({ outcome: 'present' }),
      restoreBranch: (_repository, branch, tip) => {
        restored.push(`${branch}@${tip}`)
        return { ok: true }
      },
      leaseState: () => 'missing',
      pidAlive: () => false,
    },
    synchronize: (_row, reconcile) => reconcile(),
  })

  expect(restored).toEqual([`${fixture.branch}@${fixture.tip}`])
  expect(claimState(fixture.claimId)).toEqual({
    state: 'retained',
    settled_detail: `branch retained at ${fixture.tip}`,
  })
})

test('a kept branch recorded by another turn without any tip is released with the loss recorded', () => {
  const fixture = markKeptOnAnotherTurn(null)
  const lines: string[] = []

  reconcileAbsentClaims({
    dryRun: false,
    project: fixture.project,
    presentation: linePresentation(lines),
    trust: { succeeded: true, headings: [] },
    database: db(),
    observers: {
      ref: () => ({ outcome: 'absent' }),
      leaseState: () => 'missing',
      pidAlive: () => false,
    },
    synchronize: (_row, reconcile) => reconcile(),
  })

  expect(claimState(fixture.claimId)).toEqual({
    state: 'absent',
    settled_detail: `branch ${fixture.branch} lost; no tip was recorded`,
  })
  expect(lines).toEqual([
    `released, no tip was recorded: claim ${fixture.claimId} branch ${fixture.ref}`,
  ])
})

test('a present kept branch settles retained without restoration', () => {
  const fixture = keptBranchClaim()
  let restores = 0

  reconcileAbsentClaims({
    dryRun: false,
    project: fixture.project,
    presentation: linePresentation([]),
    trust: { succeeded: true, headings: [] },
    database: db(),
    observers: {
      ref: () => ({ outcome: 'present' }),
      restoreBranch: () => {
        restores++
        return { ok: true }
      },
      leaseState: () => 'missing',
      pidAlive: () => false,
    },
    synchronize: (_row, reconcile) => reconcile(),
  })

  expect(restores).toBe(0)
  expect(claimState(fixture.claimId).state).toBe('retained')
})

test('a kept branch whose tip is gone releases with visible loss detail', () => {
  const fixture = keptBranchClaim()
  const lines: string[] = []

  reconcileAbsentClaims({
    dryRun: false,
    project: fixture.project,
    presentation: linePresentation(lines),
    trust: { succeeded: true, headings: [] },
    database: db(),
    observers: {
      ref: () => ({ outcome: 'absent' }),
      commit: () => ({ outcome: 'absent' }),
      leaseState: () => 'missing',
      pidAlive: () => false,
    },
    synchronize: (_row, reconcile) => reconcile(),
  })

  expect(claimState(fixture.claimId)).toEqual({
    state: 'absent',
    settled_detail: `branch ${fixture.branch} lost; tip ${fixture.tip} is gone`,
  })
  expect(lines).toEqual([
    `released, tip ${fixture.tip} is gone: claim ${fixture.claimId} branch ${fixture.ref}`,
  ])
})

test('a failed kept-branch restore leaves the claim claimed and prints the git failure', () => {
  const fixture = keptBranchClaim()
  const lines: string[] = []

  reconcileAbsentClaims({
    dryRun: false,
    project: fixture.project,
    presentation: linePresentation(lines),
    trust: { succeeded: true, headings: [] },
    database: db(),
    observers: {
      ref: () => ({ outcome: 'absent' }),
      commit: () => ({ outcome: 'present' }),
      restoreBranch: () => ({ ok: false, error: 'fatal: cannot lock ref' }),
      leaseState: () => 'missing',
      pidAlive: () => false,
    },
    synchronize: (_row, reconcile) => reconcile(),
  })

  expect(claimState(fixture.claimId)).toEqual({ state: 'claimed', settled_detail: null })
  expect(lines).toEqual([
    `kept: claim ${fixture.claimId} branch ${fixture.ref}: restore failed: fatal: cannot lock ref`,
  ])
})

test('kept-branch dry runs change nothing and print each prospective action', () => {
  const restore = keptBranchClaim('a'.repeat(40))
  const present = keptBranchClaim('b'.repeat(40))
  const lost = keptBranchClaim('c'.repeat(40))
  const noTip = keptBranchClaim(null)
  const lines: string[] = []

  for (const [fixture, refOutcome, commitOutcome] of [
    [restore, 'absent', 'present'],
    [present, 'present', 'absent'],
    [lost, 'absent', 'absent'],
    [noTip, 'absent', 'absent'],
  ] as const) {
    reconcileAbsentClaims({
      dryRun: true,
      project: fixture.project,
      presentation: linePresentation(lines),
      trust: { succeeded: true, headings: [] },
      database: db(),
      observers: {
        ref: () => ({ outcome: refOutcome }),
        commit: () => ({ outcome: commitOutcome }),
        leaseState: () => 'missing',
        pidAlive: () => false,
      },
    })
  }

  expect(
    [restore, present, lost, noTip].map((fixture) => claimState(fixture.claimId).state),
  ).toEqual(['claimed', 'claimed', 'claimed', 'claimed'])
  expect(lines).toEqual([
    `would restore ${restore.branch} at ${restore.tip}`,
    `would settle retained claim ${present.claimId} branch ${present.ref}`,
    `would release, tip ${lost.tip} is gone: claim ${lost.claimId} branch ${lost.ref}`,
    `would release, no tip was recorded: claim ${noTip.claimId} branch ${noTip.ref}`,
  ])
})

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

test('reconciling an absent worktree leaves its dependent port claimed', () => {
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
    { kind: 'port', state: 'claimed' },
  ])
})

test('an absent worktree does not release allocations shared with a present worktree', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const project = `claim-multiple-trees-${runId}`
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
  insert.run(runId, runId, projectId, 'worktree', '/present-tree', nowIso())
  insert.run(runId, runId, projectId, 'port', '21992', nowIso())
  insert.run(runId, runId, projectId, 'index', '7', nowIso())
  insert.run(runId, runId, projectId, 'string', 'shared-value', nowIso())

  reconcileAbsentClaims({
    dryRun: false,
    project,
    presentation: { log: () => {}, error: () => {}, setExitCode: () => {}, keptBranchLine: String },
    trust: { succeeded: true, headings: [] },
    database: db(),
    observers: {
      path: (path) => ({ outcome: path === '/present-tree' ? 'present' : 'absent' }),
      ref: () => ({ outcome: 'failed', detail: 'unused' }),
      trust: { succeeded: true, headings: [] },
      leaseState: () => 'missing',
      pidAlive: () => false,
    },
    synchronize: (_row, reconcile) => reconcile(),
  })

  expect(
    db()
      .query('SELECT kind,allocation_key,state FROM resource_claim WHERE root_run_id=? ORDER BY id')
      .all(runId),
  ).toEqual([
    { kind: 'worktree', allocation_key: '/absent-tree', state: 'absent' },
    { kind: 'worktree', allocation_key: '/present-tree', state: 'claimed' },
    { kind: 'port', allocation_key: '21992', state: 'claimed' },
    { kind: 'index', allocation_key: '7', state: 'claimed' },
    { kind: 'string', allocation_key: 'shared-value', state: 'claimed' },
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
