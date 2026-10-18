// concern: scheduled run-store leftover cleanup adapter
/** Inventories run-owned directories, applies the leftover policy, and reports measured removal. */

import type { Database } from 'bun:sqlite'
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { releaseSandboxDirectoryForConversation } from '../close/close-out.ts'
import { db } from '../database/db.ts'
import { chainScoreJoin, EVIDENCE_CLOSED_SQL } from '../evidence/evidence-query.ts'
import {
  noRepoIsolatePath,
  RUNS_DIR,
  runArtifactsDir,
  runSandboxDir,
  runScratchDir,
} from '../run/run-artifacts.ts'
import { chainTerminationAtForRoot } from '../run/run-chain.ts'
import { STORAGE_WALK_ENTRY_LIMIT, walkStoragePaths } from '../storage-walk.ts'
import type { CleanupPresentation } from './cleanup.ts'
import {
  decideRunLeftover,
  type RunLeftoverDecision,
  type RunLeftoverKind,
} from './run-leftover-decision.ts'

type RunRow = {
  id: number
  record_id: string
  parent_run_id: number | null
  status: string
  project_record_id: string | null
  judged: number
}

type Measurement = {
  bytes: number
  newestEntryAt: number | null
  complete: boolean
  detail: string | null
}

const KINDS = ['scratch', 'sandbox', 'isolate', 'artifacts', 'orphan'] as const

function measure(path: string, includeAge: boolean): Measurement {
  const walked = walkStoragePaths(
    [path],
    (_root, relativePath) => {
      if (!includeAge) return { mtimeMs: null }
      try {
        return { mtimeMs: lstatSync(join(path, relativePath)).mtimeMs }
      } catch {
        return { mtimeMs: null }
      }
    },
    STORAGE_WALK_ENTRY_LIMIT,
  )
  const failures = [...walked.errors, ...(walked.unreadable ? [walked.unreadable] : [])]
  const times = walked.observations.flatMap((entry) =>
    entry.mtimeMs === null ? [] : [entry.mtimeMs],
  )
  return {
    bytes: walked.observations.reduce((total, entry) => total + entry.bytes, 0),
    newestEntryAt: includeAge && times.length > 0 ? Math.max(...times) : null,
    complete: !walked.stoppedAtLimit && failures.length === 0,
    detail: walked.stoppedAtLimit
      ? `storage walk stopped at the ${STORAGE_WALK_ENTRY_LIMIT}-entry cap`
      : (failures[0] ?? null),
  }
}

function directoryPresent(path: string): { present: boolean; reason: string | null } {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return { present: true, reason: 'path is a symlink' }
    if (!stat.isDirectory()) return { present: true, reason: 'path is not a directory' }
    return { present: true, reason: null }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, reason: null }
    return { present: true, reason: String((cause as Error).message ?? cause) }
  }
}

function scoreRemedy(runId: number): string {
  return `${PLATFORM_SLUG} score ${runId}`
}

type Candidate = {
  path: string
  kind: RunLeftoverKind
  runId: number | null
  decision: RunLeftoverDecision
  measurement?: Measurement
}

function removeCandidate(
  candidate: Candidate,
  dryRun: boolean,
  remove: SweepInput['remove'],
): string | null {
  if (remove) {
    remove(candidate, dryRun)
    return null
  }
  if (candidate.kind === 'sandbox') {
    const result = releaseSandboxDirectoryForConversation(candidate.runId!, { dryRun })
    return result.outcome === 'released' ? null : result.detail
  }
  if (!dryRun) rmSync(candidate.path, { recursive: true })
  return null
}

function candidateRemedy(candidate: Candidate): string {
  return candidate.decision.action === 'keep' && candidate.decision.remedy === 'score'
    ? `; remedy: ${scoreRemedy(candidate.runId!)}`
    : ''
}

function applyCandidate(
  candidate: Candidate,
  dryRun: boolean,
  presentation: CleanupPresentation,
  freed: Record<RunLeftoverKind, number>,
  partial: Set<RunLeftoverKind>,
  remove: SweepInput['remove'],
): boolean {
  const state = directoryPresent(candidate.path)
  const remedy = candidateRemedy(candidate)
  if (!state.present) {
    if (remedy)
      presentation.log(
        `kept ${candidate.kind} for run ${candidate.runId}: ${candidate.decision.reason}${remedy}`,
      )
    return false
  }
  if (state.reason) {
    presentation.log(`kept ${candidate.kind} ${candidate.path}: ${state.reason}`)
    return false
  }
  if (candidate.decision.action === 'keep') {
    presentation.log(
      `kept ${candidate.kind} ${candidate.path}: ${candidate.decision.reason}${remedy}`,
    )
    return false
  }
  const measurement = candidate.measurement ?? measure(candidate.path, false)
  if (!measurement.complete) partial.add(candidate.kind)
  try {
    const keptReason = removeCandidate(candidate, dryRun, remove)
    if (keptReason !== null) {
      presentation.log(`kept ${candidate.kind} ${candidate.path}: ${keptReason}`)
      return false
    }
    freed[candidate.kind] += measurement.bytes
    if (measurement.detail)
      presentation.log(
        `${dryRun ? 'would remove' : 'removed'} ${candidate.kind} ${candidate.path}: measured at least ${measurement.bytes} bytes; ${measurement.detail}`,
      )
    return false
  } catch (cause) {
    presentation.log(
      `kept ${candidate.kind} ${candidate.path}: removal failed: ${String((cause as Error).message ?? cause)}`,
    )
    return true
  }
}

function rowsForSweep(database: Database, projectRecordId: string | null): RunRow[] {
  return database
    .query(
      `SELECT r.id,r.record_id,r.parent_run_id,r.status,r.project_record_id,
              ${EVIDENCE_CLOSED_SQL} AS judged
         FROM run r ${chainScoreJoin('r', 's')}
        WHERE ? IS NULL OR r.project_record_id=?
        ORDER BY r.id`,
    )
    .all(projectRecordId, projectRecordId) as RunRow[]
}

type SweepInput = {
  dryRun: boolean
  projectRecordId: string | null
  presentation: CleanupPresentation
  clock?: number
  database?: Database
  runsDir?: string
  evidenceClosedRootIds?: ReadonlySet<number>
  remove?: (
    candidate: { path: string; kind: RunLeftoverKind; runId: number | null },
    dryRun: boolean,
  ) => void
}

type SweepState = {
  freed: Record<RunLeftoverKind, number>
  partial: Set<RunLeftoverKind>
}

function sweepRecordedLeftovers(
  input: SweepInput,
  rows: readonly RunRow[],
  clock: number,
  state: SweepState,
): boolean {
  const runsDir = input.runsDir ?? RUNS_DIR
  const terminationByRoot = new Map<number, number | null>()
  let failed = false
  for (const row of rows) {
    const rootId = row.parent_run_id ?? row.id
    if (!terminationByRoot.has(rootId)) {
      const termination = chainTerminationAtForRoot(input.database ?? db(), rootId)
      const timestamp = termination === null ? Number.NaN : Date.parse(termination)
      terminationByRoot.set(rootId, Number.isFinite(timestamp) ? timestamp : null)
    }
    const facts = {
      runStatus: row.status,
      finishedAt: terminationByRoot.get(rootId) ?? null,
      judged: Boolean(row.judged) || (input.evidenceClosedRootIds?.has(rootId) ?? false),
      newestEntryAt: null,
      clock,
    }
    for (const [kind, path] of [
      ['scratch', runScratchDir(row.id, runsDir)],
      ['isolate', noRepoIsolatePath(row.id, runsDir)],
      ['artifacts', runArtifactsDir(row.id, runsDir)],
    ] as const) {
      const candidateFailed = applyCandidate(
        { path, kind, runId: row.id, decision: decideRunLeftover({ kind, ...facts }) },
        input.dryRun,
        input.presentation,
        state.freed,
        state.partial,
        input.remove,
      )
      failed ||= candidateFailed
    }
    if (rootId !== row.id) continue
    const sandboxFailed = applyCandidate(
      {
        path: runSandboxDir(rootId, runsDir),
        kind: 'sandbox',
        runId: rootId,
        decision: decideRunLeftover({
          kind: 'sandbox',
          runStatus: row.status,
          finishedAt: facts.finishedAt,
          judged: facts.judged,
          newestEntryAt: null,
          clock,
        }),
      },
      input.dryRun,
      input.presentation,
      state.freed,
      state.partial,
      input.remove,
    )
    failed ||= sandboxFailed
  }
  return failed
}

function sweepOrphans(
  input: SweepInput,
  rows: readonly RunRow[],
  clock: number,
  state: SweepState,
): boolean {
  const runsDir = input.runsDir ?? RUNS_DIR
  if (input.projectRecordId !== null || !existsSync(runsDir)) return false
  const claimed = new Set(rows.map((row) => row.record_id.toLowerCase()))
  let failed = false
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const identity = entry.name.startsWith('sandbox-')
      ? entry.name.slice('sandbox-'.length)
      : entry.name
    if (!hasRecordIdShape(identity) || claimed.has(identity.toLowerCase())) continue
    const path = join(runsDir, entry.name)
    const measurement = measure(path, true)
    const decision = decideRunLeftover({
      kind: 'orphan',
      runStatus: null,
      finishedAt: null,
      judged: false,
      newestEntryAt: measurement.complete ? measurement.newestEntryAt : null,
      clock,
    })
    const ruling = measurement.complete
      ? decision
      : {
          action: 'keep' as const,
          reason: `orphan age could not be established: ${measurement.detail ?? 'storage walk was incomplete'}`,
        }
    const orphanFailed = applyCandidate(
      { path, kind: 'orphan', runId: null, decision: ruling, measurement },
      input.dryRun,
      input.presentation,
      state.freed,
      state.partial,
      input.remove,
    )
    failed ||= orphanFailed
  }
  return failed
}

function reportFreed(input: SweepInput, state: SweepState): void {
  for (const kind of KINDS) {
    const qualifier = state.partial.has(kind) ? 'at least ' : ''
    input.presentation.log(
      `${input.dryRun ? 'would free' : 'freed'} ${kind}: ${qualifier}${state.freed[kind]} bytes`,
    )
  }
}

/** Scheduled backstop for run-store residue; reader-clone archives remain under their own policy. */
export function sweepRunLeftovers(input: SweepInput): {
  failed: boolean
  freed: Record<RunLeftoverKind, number>
} {
  const database = input.database ?? db()
  const clock = input.clock ?? Date.now()
  const rows = rowsForSweep(database, input.projectRecordId)
  const state: SweepState = {
    freed: Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<RunLeftoverKind, number>,
    partial: new Set(),
  }
  const recordedFailed = sweepRecordedLeftovers({ ...input, database }, rows, clock, state)
  const orphanFailed = sweepOrphans(input, rows, clock, state)
  reportFreed(input, state)
  return { failed: recordedFailed || orphanFailed, freed: state.freed }
}
