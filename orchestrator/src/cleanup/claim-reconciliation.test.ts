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
