import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import type { BranchPruneKeptReason } from '../branch/branch-state.ts'
import { db } from '../database/db.ts'
import type { HookTreeRemovalResult } from '../hook-tree/tree.ts'
import { runArtifactsDir, runScratchDir } from '../run/run-artifacts.ts'
import { formatShipCleanup, type ShipCleanupDependencies, shipCleanup } from './ship-cleanup.ts'

function addProject(): string {
  const recordId = newRecordId()
  db()
    .query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
    .run(recordId, 'ship-fixture', '/fixture', 'bun', JSON.stringify({ trunk: 'main' }))
  return recordId
}

function addLanding(project: string): void {
  db()
    .query(
      `INSERT INTO branch_landing_record
       (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      'ship-fixture',
      project,
      'DEV-1392-c3',
      'tip',
      1392,
      'merge',
      '2026-10-18T01:00:00Z',
      '2026-10-18T01:00:01Z',
    )
}

function addRun(
  project: string,
  input: {
    job?: string
    status?: string
    branch?: string | null
    key?: string | null
    parent?: string | null
    worktree?: string | null
    judged?: boolean
    startedAt?: string
  } = {},
): string {
  const row = db()
    .query(
      `INSERT INTO run
        (record_id,number,started_at,agent,job,project_record_id,prompt_sha,prompt_bytes,prompt_head,status,
         branch,launch_key,parent_run_record_id,worktree)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,?,?,?,?,1,'prompt',?,?,?,?,?) RETURNING record_id AS id`,
    )
    .get(
      newRecordId(),
      input.startedAt ?? '2026-10-18T00:00:00Z',
      'codex',
      input.job ?? 'implement',
      project,
      'sha',
      input.status ?? 'ok',
      input.branch === undefined ? 'DEV-1392-c3' : input.branch,
      input.key === undefined ? 'DEV-1392' : input.key,
      input.parent ?? null,
      input.worktree ?? null,
    ) as { id: string }
  if (input.judged) {
    db()
      .query(
        `INSERT INTO score (record_id,run_record_id,delivery,quality,fidelity,scored_at)
         VALUES (?,?,'full','right','faithful','2026-10-18T01:00:00Z')`,
      )
      .run(newRecordId(), row.id)
  }
  return row.id
}

test('ship cleanup gathers branch facts and applies only the pure decision', () => {
  const project = addProject()
  addLanding(project)
  const root = addRun(project, {
    branch: 'DEV-1392-c2',
    judged: true,
    worktree: '/trees/root',
  })
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
  const later = addRun(project, {
    startedAt: '2026-10-18T02:00:00Z',
    judged: true,
    worktree: '/trees/later',
  })
  const archiveRoot = mkdtempSync(join(tmpdir(), 'ship-cleanup-archive-'))
  const lensArchive = join(archiveRoot, 'lens')
  const lensPointer = join(runArtifactsDir(lens), 'reader-clone-archive.json')
  mkdirSync(runScratchDir(lens), { recursive: true })
  writeFileSync(join(runScratchDir(lens), 'scratch.txt'), 'scratch')
  const removed = new Set<string>()
  const removedLandingTrees: string[] = []
  const closed: string[] = []
  const pruned: string[][] = []
  const dependencies: ShipCleanupDependencies = {
    localBranchExists: () => true,
    landingState: () => ({
      state: 'landed',
      landedBy: { type: 'patch-equivalent', form: 'squash' },
    }),
    closeOut: (id) => {
      closed.push(id)
      if (id === lens) {
        mkdirSync(lensArchive, { recursive: true })
        writeFileSync(join(lensArchive, 'clone.txt'), 'clone')
        mkdirSync(runArtifactsDir(lens), { recursive: true })
        writeFileSync(lensPointer, `${JSON.stringify({ path: lensArchive })}\n`)
      }
      return { outcome: 'released', detail: 'released' }
    },
    prune: (name, branch) => {
      pruned.push([name, branch])
      return { deleted: [branch], kept: [], errors: [] }
    },
    measure: (paths) => ({
      bytes: paths.filter((path) => !removed.has(path)).length * 10,
      errors: [],
      stoppedAtLimit: false,
    }),
    remove: (path) => {
      removed.add(path)
      rmSync(path, { recursive: true, force: true })
    },
    reclaimProcesses: (paths) => ({
      reclaimed: paths.map((path) => `stopped ${path}`),
      kept: [],
      errors: [],
    }),
    reclaimCompose: (trees) => ({
      removed: trees.map(({ path }) => `stack:${path}`),
      kept: [],
      errors: [],
    }),
    readerCloneArchive: (id) => {
      if (id !== lens || !existsSync(lensPointer)) return null
      return (JSON.parse(readFileSync(lensPointer, 'utf8')) as { path: string }).path
    },
    runsFromTree: () => false,
    removeLandingTree: () => {
      removedLandingTrees.push('/trees/landing')
      removed.add('/trees/landing')
      return { outcome: 'released' }
    },
  }

  const report = shipCleanup('DEV-1392-c3', {
    project: 'ship-fixture',
    confirmedLanded: true,
    database: db(),
    dependencies,
  })
  const numberOf = (recordId: string): number =>
    (db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as { number: number })
      .number

  expect(report.removed.artifacts).toEqual([root, turn, lens, landing])
  expect(report.removed.scratch).toEqual([root, turn, lens, landing])
  expect(closed).toEqual([root, lens, unscored])
  expect(removedLandingTrees).toEqual(['/trees/landing'])
  expect(closed).not.toContain(live)
  expect(closed).not.toContain(sibling)
  expect(closed).not.toContain(keyless)
  expect(closed).not.toContain(later)
  expect(report.kept).toContainEqual({
    item: `run ${numberOf(unscored)} artifacts and scratch`,
    reason: 'run has no recorded verdict',
    reasonKind: 'unjudged-run',
    remedy: `${PLATFORM_SLUG} score ${numberOf(unscored)}`,
  })
  expect(report.kept).toContainEqual({
    item: `run ${numberOf(live)} artifacts and scratch and worktree`,
    reason: 'run is live (running)',
    reasonKind: 'live-run',
  })
  expect(pruned).toEqual([['ship-fixture', 'DEV-1392-c3']])
  expect(report.reclaimed.processes).toEqual([
    'stopped /trees/root',
    'stopped /trees/lens',
    'stopped /trees/unscored',
    'stopped /trees/landing',
  ])
  expect(report.reclaimed.compose).toEqual([
    'stack:/trees/root',
    'stack:/trees/lens',
    'stack:/trees/unscored',
    'stack:/trees/landing',
  ])
  expect(formatShipCleanup(report)).toContain('reclaimed process: stopped /trees/root')
  expect(formatShipCleanup(report)).toContain('reclaimed Compose resource: stack:/trees/landing')
  report.gone.push('DEV-1392-old')
  expect(formatShipCleanup(report)).toContain('already gone: DEV-1392-old')
  expect(existsSync(runArtifactsDir(lens))).toBe(false)
  expect(existsSync(runScratchDir(lens))).toBe(false)
  expect(existsSync(lensArchive)).toBe(false)
  rmSync(archiveRoot, { recursive: true, force: true })
})

test('ship cleanup refuses a landed classification without a recorded landing time', () => {
  addProject()
  const unavailable = (): never => {
    throw new Error('cleanup should not start')
  }
  const dependencies: ShipCleanupDependencies = {
    localBranchExists: () => true,
    landingState: () => ({
      state: 'landed',
      landedBy: { type: 'patch-equivalent', form: 'squash' },
    }),
    closeOut: unavailable,
    prune: unavailable,
    measure: unavailable,
    readerCloneArchive: unavailable,
    runsFromTree: () => false,
    removeLandingTree: unavailable,
    remove: unavailable,
    reclaimProcesses: unavailable,
    reclaimCompose: unavailable,
  }

  expect(() =>
    shipCleanup('DEV-1392-c3', {
      project: 'ship-fixture',
      database: db(),
      dependencies,
    }),
  ).toThrow(
    `refusing ship cleanup: branch DEV-1392-c3 has no recorded landing time; cleared by: ${PLATFORM_SLUG} tree branch landed DEV-1392-c3 --pr <number>`,
  )
})

function landingTreeCleanup(input: {
  removal?: HookTreeRemovalResult
  runsFromTree?: boolean
  pruneKept?: { branch: string; reason: BranchPruneKeptReason }[]
}): {
  report: ReturnType<typeof shipCleanup>
  landingTree: string
  removedTrees: string[]
  closed: string[]
} {
  const project = addProject()
  addLanding(project)
  const landingTree = '/trees/landing'
  addRun(project, {
    job: 'landing-tree',
    judged: true,
    worktree: landingTree,
  })
  const removedTrees: string[] = []
  const closed: string[] = []
  const dependencies: ShipCleanupDependencies = {
    localBranchExists: () => true,
    landingState: () => ({
      state: 'landed',
      landedBy: { type: 'patch-equivalent', form: 'squash' },
    }),
    closeOut: (id) => {
      closed.push(id)
      return { outcome: 'released', detail: 'released' }
    },
    prune: () => ({ deleted: [], kept: input.pruneKept ?? [], errors: [] }),
    measure: () => ({ bytes: 0, errors: [], stoppedAtLimit: false }),
    readerCloneArchive: () => null,
    runsFromTree: () => input.runsFromTree ?? false,
    removeLandingTree: () => {
      const removal = input.removal ?? { outcome: 'released' }
      if (removal.outcome === 'released') removedTrees.push(landingTree)
      return removal
    },
    remove: () => {},
    reclaimProcesses: () => ({ reclaimed: [], kept: [], errors: [] }),
    reclaimCompose: () => ({ removed: [], kept: [], errors: [] }),
  }
  return {
    report: shipCleanup('DEV-1392-c3', {
      cwd: landingTree,
      project: 'ship-fixture',
      confirmedLanded: true,
      database: db(),
      dependencies,
    }),
    landingTree,
    removedTrees,
    closed,
  }
}

test('ship cleanup keeps its current landing tree and checked-out branch without failure', () => {
  const result = landingTreeCleanup({
    runsFromTree: true,
    pruneKept: [{ branch: 'DEV-1392-c3', reason: 'checked-out' }],
  })
  const remedy =
    `${PLATFORM_SLUG} tree remove ${result.landingTree}, then ` +
    `${PLATFORM_SLUG} tree ship-cleanup DEV-1392-c3`

  expect(result.removedTrees).toEqual([])
  expect(result.report.kept).toContainEqual({
    item: expect.stringMatching(/^run \d+ worktree$/),
    reason: 'the command runs from this tree',
    reasonKind: 'command-tree',
    remedy,
  })
  expect(result.report.kept).toContainEqual({
    item: 'branch DEV-1392-c3',
    reason: 'checked-out',
    reasonKind: 'safety-hold',
    remedy,
  })
  expect(result.report.errors).toEqual([])
})

test('ship cleanup keeps a dirty landing tree and names its dirty paths', () => {
  const result = landingTreeCleanup({
    removal: {
      outcome: 'kept',
      reason: 'landing tree held by its invoking session: tree is dirty: tracked.ts, new file.ts',
    },
  })

  expect(result.removedTrees).toEqual([])
  expect(result.report.kept).toContainEqual({
    item: expect.stringMatching(/^run \d+ worktree$/),
    reason: 'landing tree held by its invoking session: tree is dirty: tracked.ts, new file.ts',
    reasonKind: 'safety-hold',
    remedy:
      `${PLATFORM_SLUG} tree remove ${result.landingTree}, then ` +
      `${PLATFORM_SLUG} tree ship-cleanup DEV-1392-c3`,
  })
  expect(result.report.errors).toEqual([])
})
