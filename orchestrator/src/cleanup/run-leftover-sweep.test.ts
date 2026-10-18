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
import { sweepRunLeftovers } from './run-leftover-sweep.ts'

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
    db().query('UPDATE run SET latency_ms=? WHERE id=?').run(1_000, runId)
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

  test('keeps old unjudged artifacts with the score remedy', () => {
    const root = runsRoot()
    const runId = addRun({
      agent: 'codex',
      job: 'implement',
      status: 'failed',
      startedAt: old.toISOString(),
    })
    db().query('UPDATE run SET latency_ms=? WHERE id=?').run(1_000, runId)
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
    expect(lines.join('\n')).toContain(`remedy: ${PLATFORM_SLUG} score ${runId}`)

    const dry = sweepRunLeftovers({
      dryRun: true,
      projectRecordId: null,
      presentation: presentation([]),
      clock,
      runsDir: root,
      judgedRootIds: new Set([runId]),
      remove: removeCandidate,
    })
    expect(dry.freed.artifacts).toBeGreaterThan(0)
    expect(existsSync(artifacts)).toBeTrue()
  })

  test('removes an old orphan and keeps a young orphan', () => {
    const root = runsRoot()
    const oldOrphan = join(root, newRecordId())
    const youngOrphan = join(root, newRecordId())
    directory(oldOrphan)
    directory(youngOrphan, new Date(clock))
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
    expect(lines.join('\n')).toContain(`kept orphan ${youngOrphan}`)
  })
})
