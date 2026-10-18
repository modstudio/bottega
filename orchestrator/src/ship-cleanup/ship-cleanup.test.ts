import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { type ShipCleanupDependencies, shipCleanup } from './ship-cleanup.ts'

function addProject(): string {
  const recordId = newRecordId()
  db()
    .query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
    .run(recordId, 'ship-fixture', '/fixture', 'bun', JSON.stringify({ trunk: 'main' }))
  return recordId
}

function addRun(
  project: string,
  input: {
    job?: string
    status?: string
    branch?: string | null
    key?: string | null
    parent?: number | null
    worktree?: string | null
    judged?: boolean
  } = {},
): number {
  const row = db()
    .query(
      `INSERT INTO run
        (record_id,started_at,agent,job,project_record_id,prompt_sha,prompt_bytes,prompt_head,status,
         branch,launch_key,parent_run_id,worktree)
       VALUES (?,?,?,?,?,?,1,'prompt',?,?,?,?,?) RETURNING id`,
    )
    .get(
      newRecordId(),
      '2026-10-18T00:00:00Z',
      'codex',
      input.job ?? 'implement',
      project,
      'sha',
      input.status ?? 'ok',
      input.branch === undefined ? 'DEV-1392-c3' : input.branch,
      input.key === undefined ? 'DEV-1392' : input.key,
      input.parent ?? null,
      input.worktree ?? null,
    ) as { id: number }
  if (input.judged) {
    db()
      .query(
        `INSERT INTO score (record_id,run_id,delivery,quality,fidelity,scored_at)
         VALUES (?,?,'full','right','faithful','2026-10-18T01:00:00Z')`,
      )
      .run(newRecordId(), row.id)
  }
  return row.id
}

test('ship cleanup gathers branch facts and applies only the pure decision', () => {
  const project = addProject()
  const root = addRun(project, { judged: true, worktree: '/trees/root' })
  const turn = addRun(project, { parent: root })
  const lens = addRun(project, { job: 'review-lens', judged: true, worktree: '/trees/lens' })
  const unscored = addRun(project, { worktree: '/trees/unscored' })
  const live = addRun(project, { status: 'running', worktree: '/trees/live' })
  const sibling = addRun(project, {
    branch: 'DEV-1392-c2',
    judged: true,
    worktree: '/trees/sibling',
  })
  const keyless = addRun(project, { key: null, judged: true, worktree: '/trees/keyless' })
  const landing = addRun(project, {
    job: 'landing-tree',
    judged: true,
    worktree: '/trees/landing',
  })
  const removed = new Set<string>()
  const closed: number[] = []
  const pruned: string[][] = []
  const dependencies: ShipCleanupDependencies = {
    landingState: () => 'landed',
    closeOut: (id) => {
      closed.push(id)
      return { outcome: 'released', detail: 'released' }
    },
    prune: (name, branch, key) => {
      pruned.push([name, branch, key])
      return { deleted: [branch], kept: [], errors: [] }
    },
    measure: (paths) => ({
      bytes: paths.filter((path) => !removed.has(path)).length * 10,
      errors: [],
      stoppedAtLimit: false,
    }),
    remove: (path) => {
      removed.add(path)
    },
  }

  const report = shipCleanup('DEV-1392-c3', {
    project: 'ship-fixture',
    confirmedLanded: true,
    database: db(),
    dependencies,
  })

  expect(report.removed.artifacts).toEqual([root, turn, lens, landing])
  expect(report.removed.scratch).toEqual([root, turn, lens, landing])
  expect(closed).toEqual([root, lens, unscored, landing])
  expect(closed).not.toContain(live)
  expect(closed).not.toContain(sibling)
  expect(closed).not.toContain(keyless)
  expect(report.kept).toContainEqual({
    item: `run ${unscored} artifacts and scratch`,
    reason: 'run has no recorded verdict',
    remedy: `${PLATFORM_SLUG} score ${unscored}`,
  })
  expect(report.kept).toContainEqual({
    item: `run ${live} artifacts and scratch and worktree`,
    reason: 'run is live (running)',
  })
  expect(pruned).toEqual([['ship-fixture', 'DEV-1392-c3', 'DEV-1392']])
})
