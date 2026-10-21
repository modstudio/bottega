import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  noRepoIsolatePath,
  runArtifactsDir,
  runSandboxDir,
  runScratchDir,
} from '../run/run-artifacts.ts'
import type { CleanupPresentation } from './cleanup.ts'
import {
  keptRunLeftoverLines,
  RUN_LEFTOVER_REPORT_EXAMPLES,
  sweepRunLeftovers,
} from './run-leftover-sweep.ts'

const clock = Date.parse('2026-10-18T12:00:00.000Z')
const old = new Date(clock - 4 * 24 * 60 * 60 * 1000)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function presentation(lines: string[]): CleanupPresentation {
  return {
    log: (...values) => lines.push(values.join(' ')),
    error: (...values) => lines.push(values.join(' ')),
    setExitCode: () => {},
    keptBranchLine: () => '',
  }
}

function directory(path: string, timestamp = old): void {
  mkdirSync(path, { recursive: true })
  const file = join(path, 'leftover.txt')
  writeFileSync(file, 'leftover')
  utimesSync(file, timestamp, timestamp)
  utimesSync(path, timestamp, timestamp)
}

function runsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'run-leftover-sweep-'))
  roots.push(root)
  return root
}

function removeCandidate(candidate: { path: string }, dryRun: boolean): void {
  if (!dryRun) rmSync(candidate.path, { recursive: true })
}

describe('scheduled run leftover sweep adapter', () => {
  test('dry-run and removal use the same measured plan for an old judged run', () => {
    const root = runsRoot()
    const runId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      startedAt: old.toISOString(),
    })
    db().query('UPDATE run SET latency_ms=? WHERE record_id=?').run(1_000, runId)
    score(runId, 'full', 'right', 'faithful')
    const paths = [
      runScratchDir(runId, root),
      noRepoIsolatePath(runId, root),
      runArtifactsDir(runId, root),
      runSandboxDir(runId, root),
    ]
    for (const path of paths) directory(path)

    const dryLines: string[] = []
    const dry = sweepRunLeftovers({
      dryRun: true,
      projectRecordId: null,
      presentation: presentation(dryLines),
      clock,
      runsDir: root,
      remove: removeCandidate,
    })
    expect(paths.every(existsSync)).toBeTrue()
    expect(Object.values(dry.freed).reduce((total, bytes) => total + bytes, 0)).toBeGreaterThan(0)

    const result = sweepRunLeftovers({
      dryRun: false,
      projectRecordId: null,
      presentation: presentation([]),
      clock,
      runsDir: root,
      remove: removeCandidate,
    })
    expect(paths.some(existsSync)).toBeFalse()
    expect(result.freed).toEqual(dry.freed)
  })

  test('keeps old unjudged artifacts with the pending-scores remedy', () => {
    const root = runsRoot()
    const runId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'failed',
      startedAt: old.toISOString(),
    })
    db().query('UPDATE run SET latency_ms=? WHERE record_id=?').run(1_000, runId)
    const artifacts = runArtifactsDir(runId, root)
    directory(artifacts)
    const lines: string[] = []

    sweepRunLeftovers({
      dryRun: false,
      projectRecordId: null,
      presentation: presentation(lines),
      clock,
      runsDir: root,
      remove: removeCandidate,
    })

    expect(existsSync(artifacts)).toBeTrue()
    const runNumber = (
      db().query('SELECT number FROM run WHERE record_id=?').get(runId) as { number: number }
    ).number
    expect(lines.join('\n')).toContain(`example runs: ${runNumber}`)
    expect(lines.join('\n')).toContain(`${PLATFORM_SLUG} score pending lists every unjudged run`)

    const dry = sweepRunLeftovers({
      dryRun: true,
      projectRecordId: null,
      presentation: presentation([]),
      clock,
      runsDir: root,
      evidenceClosedRootIds: new Set([runId]),
      remove: removeCandidate,
    })
    expect(dry.freed.artifacts).toBeGreaterThan(0)
    expect(existsSync(artifacts)).toBeTrue()
  })

  test('summarizes many measured candidates under one reason with five examples', () => {
    const kept = Array.from({ length: RUN_LEFTOVER_REPORT_EXAMPLES + 2 }, (_, index) => ({
      path: `/runs/${index + 1}/artifacts`,
      kind: 'artifacts' as const,
      runNumber: index + 1,
      reason: 'no recorded verdict' as const,
      bytes: 10,
      complete: true,
      remedy: 'score' as const,
    }))

    expect(keptRunLeftoverLines(kept, false)).toEqual([
      'kept 7 run artifacts with no recorded verdict (70 bytes); example runs: 1, 2, 3, 4, 5; and 2 more',
      `  ${PLATFORM_SLUG} score pending lists every unjudged run`,
    ])
  })

  test('summarizes mixed reasons separately and verbose lists every item', () => {
    const kept = [
      {
        path: '/runs/1/scratch',
        kind: 'scratch' as const,
        runNumber: 1,
        reason: 'recently finished' as const,
        bytes: 8,
        complete: true,
      },
      {
        path: '/runs/2/scratch',
        kind: 'scratch' as const,
        runNumber: 2,
        reason: 'live' as const,
        status: 'asking',
        bytes: 9,
        complete: true,
      },
    ]

    expect(keptRunLeftoverLines(kept, false)).toEqual([
      'kept 1 run scratch directory not older than the run leftover age cap (8 bytes); example paths: /runs/1/scratch',
      'kept 1 run scratch directory live (9 bytes); example paths: /runs/2/scratch',
    ])
    expect(keptRunLeftoverLines(kept, true)).toEqual([
      'kept scratch /runs/1/scratch: not older than the run leftover age cap',
      'kept scratch /runs/2/scratch: live (asking)',
    ])
  })

  test('removes only old run-shaped orphans and keeps young and owned directories', () => {
    const root = runsRoot()
    const oldOrphan = join(root, newRecordId())
    const youngOrphan = join(root, newRecordId())
    const ownedDirectories = ['.signals', 'leases', 'orphans', 'gate-timings'].map((name) =>
      join(root, name),
    )
    directory(oldOrphan)
    directory(youngOrphan, new Date(clock))
    for (const path of ownedDirectories) directory(path)
    const lines: string[] = []

    sweepRunLeftovers({
      dryRun: false,
      projectRecordId: null,
      presentation: presentation(lines),
      clock,
      runsDir: root,
      remove: removeCandidate,
    })

    expect(existsSync(oldOrphan)).toBeFalse()
    expect(existsSync(youngOrphan)).toBeTrue()
    expect(ownedDirectories.every(existsSync)).toBeTrue()
    expect(lines.join('\n')).toContain(`example paths: ${youngOrphan}`)
    for (const path of ownedDirectories) expect(lines.join('\n')).not.toContain(path)
  })

  test('keeps every directory and frees no bytes for an old live run', () => {
    const root = runsRoot()
    const runId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'asking',
      startedAt: old.toISOString(),
    })
    const paths = [
      runScratchDir(runId, root),
      noRepoIsolatePath(runId, root),
      runArtifactsDir(runId, root),
      runSandboxDir(runId, root),
    ]
    for (const path of paths) directory(path)
    const lines: string[] = []

    const result = sweepRunLeftovers({
      dryRun: false,
      projectRecordId: null,
      presentation: presentation(lines),
      clock,
      runsDir: root,
      remove: removeCandidate,
    })

    expect(paths.every(existsSync)).toBeTrue()
    expect(Object.values(result.freed).every((bytes) => bytes === 0)).toBeTrue()
    expect(lines).toContainEqual(expect.stringContaining('kept 4 run leftovers live'))
    for (const path of paths) expect(lines.join('\n')).toContain(path)
  })

  test('reports the sandbox release decision reason when it remains held', () => {
    const runId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'ok',
      startedAt: old.toISOString(),
    })
    const sandbox = runSandboxDir(runId)
    const worktree = join(runsRoot(), 'held-worktree')
    directory(sandbox)
    directory(worktree)
    roots.push(sandbox)
    db().query('UPDATE run SET worktree=? WHERE record_id=?').run(worktree, runId)
    const lines: string[] = []

    const result = sweepRunLeftovers({
      dryRun: false,
      projectRecordId: null,
      presentation: presentation(lines),
      clock,
    })

    expect(existsSync(sandbox)).toBeTrue()
    expect(result.freed.sandbox).toBe(0)
    expect(lines).toContainEqual(
      expect.stringContaining('kept 1 run sandbox held by the sandbox release decision'),
    )
    expect(lines.join('\n')).not.toContain(`kept sandbox ${sandbox}:`)
    expect(lines.join('\n')).not.toContain('removal failed')

    const verboseLines: string[] = []
    sweepRunLeftovers({
      dryRun: false,
      verbose: true,
      projectRecordId: null,
      presentation: presentation(verboseLines),
      clock,
    })
    expect(verboseLines).toContainEqual(
      expect.stringContaining(`kept sandbox ${sandbox}: held by the sandbox release decision`),
    )
  })

  test('does not report an old unjudged run when it has no leftover directories', () => {
    const root = runsRoot()
    const runId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'failed',
      startedAt: old.toISOString(),
    })
    db().query('UPDATE run SET latency_ms=? WHERE record_id=?').run(1_000, runId)
    const lines: string[] = []

    sweepRunLeftovers({
      dryRun: false,
      projectRecordId: null,
      presentation: presentation(lines),
      clock,
      runsDir: root,
      remove: removeCandidate,
    })

    expect(lines.join('\n')).not.toContain('kept')
    expect(lines.join('\n')).not.toContain('score pending')
  })
})
