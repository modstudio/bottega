// concern: scheduled run-store leftover cleanup adapter
/** Inventories run-owned directories, applies the leftover policy, and reports measured removal. */

import type { Database } from 'bun:sqlite'
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import {
  noRepoIsolatePath,
  RUNS_DIR,
  runArtifactsDir,
  runSandboxDir,
  runScratchDir,
} from '../run/run-artifacts.ts'
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
  started_at: string
  latency_ms: number | null
  last_event_at: string | null
  evidence_excluded: string | null
  project_record_id: string | null
}

type Measurement = {
  bytes: number
  newestEntryAt: number | null
  complete: boolean
  detail: string | null
}

const KINDS = ['scratch', 'sandbox', 'isolate', 'artifacts', 'orphan'] as const

function finishedAt(row: RunRow): number | null {
  const started = Date.parse(row.started_at)
  if (Number.isFinite(started) && row.latency_ms !== null && Number.isFinite(row.latency_ms))
    return started + row.latency_ms
  const lastEvent = row.last_event_at === null ? Number.NaN : Date.parse(row.last_event_at)
  if (Number.isFinite(lastEvent)) return lastEvent
  return Number.isFinite(started) ? started : null
}

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

function applyCandidate(
  candidate: Candidate,
  dryRun: boolean,
  presentation: CleanupPresentation,
  freed: Record<RunLeftoverKind, number>,
  partial: Set<RunLeftoverKind>,
): boolean {
  const state = directoryPresent(candidate.path)
  const remedy =
    candidate.decision.action === 'keep' &&
    candidate.decision.reason === 'run has no recorded verdict'
      ? `; remedy: ${scoreRemedy(candidate.runId!)}`
      : ''
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
    if (!dryRun) rmSync(candidate.path, { recursive: true })
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
      `SELECT id,record_id,parent_run_id,status,started_at,latency_ms,last_event_at,
              evidence_excluded,project_record_id
         FROM run
        WHERE ? IS NULL OR project_record_id=?
        ORDER BY id`,
    )
    .all(projectRecordId, projectRecordId) as RunRow[]
}

function judgedRoots(rows: readonly RunRow[], database: Database): Set<number> {
  const rootIds = new Set(rows.map((row) => row.parent_run_id ?? row.id))
  const scored = new Set(
    (database.query('SELECT run_id FROM score').all() as { run_id: number }[]).map(
      (row) => row.run_id,
    ),
  )
  return new Set(
    rows.flatMap((row) => {
      const rootId = row.parent_run_id ?? row.id
      return rootIds.has(rootId) && (scored.has(rootId) || row.evidence_excluded !== null)
        ? [rootId]
        : []
    }),
  )
}

function conversationFacts(
  rows: readonly RunRow[],
  rootId: number,
): { status: string; finishedAt: number | null } {
  const turns = rows.filter((row) => (row.parent_run_id ?? row.id) === rootId)
  const live = turns.find((row) => !['ok', 'failed', 'stale', 'stopped'].includes(row.status))
  const finishes = turns.flatMap((row) => {
    const time = finishedAt(row)
    return time === null ? [] : [time]
  })
  return {
    status: live?.status ?? turns.at(-1)?.status ?? 'unknown',
    finishedAt:
      finishes.length === turns.length && finishes.length > 0 ? Math.max(...finishes) : null,
  }
}

type SweepInput = {
  dryRun: boolean
  projectRecordId: string | null
  presentation: CleanupPresentation
  clock?: number
  database?: Database
  runsDir?: string
  judgedRootIds?: ReadonlySet<number>
}

type SweepState = {
  freed: Record<RunLeftoverKind, number>
  partial: Set<RunLeftoverKind>
}

function sweepRecordedLeftovers(
  input: SweepInput,
  rows: readonly RunRow[],
  judged: ReadonlySet<number>,
  clock: number,
  state: SweepState,
): boolean {
  const runsDir = input.runsDir ?? RUNS_DIR
  let failed = false
  for (const row of rows) {
    const rootId = row.parent_run_id ?? row.id
    const facts = {
      runStatus: row.status,
      finishedAt: finishedAt(row),
      judged: judged.has(rootId),
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
      )
      failed ||= candidateFailed
    }
    if (rootId !== row.id) continue
    const conversation = conversationFacts(rows, rootId)
    const sandboxFailed = applyCandidate(
      {
        path: runSandboxDir(rootId, runsDir),
        kind: 'sandbox',
        runId: rootId,
        decision: decideRunLeftover({
          kind: 'sandbox',
          runStatus: conversation.status,
          finishedAt: conversation.finishedAt,
          judged: judged.has(rootId),
          newestEntryAt: null,
          clock,
        }),
      },
      input.dryRun,
      input.presentation,
      state.freed,
      state.partial,
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
    if (!entry.isDirectory() || entry.name === 'isolates') continue
    const identity = entry.name.startsWith('sandbox-')
      ? entry.name.slice('sandbox-'.length)
      : entry.name
    if (hasRecordIdShape(identity) && claimed.has(identity.toLowerCase())) continue
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
  const judged = judgedRoots(rows, database)
  for (const rootId of input.judgedRootIds ?? []) judged.add(rootId)
  const state: SweepState = {
    freed: Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<RunLeftoverKind, number>,
    partial: new Set(),
  }
  const recordedFailed = sweepRecordedLeftovers(input, rows, judged, clock, state)
  const orphanFailed = sweepOrphans(input, rows, clock, state)
  reportFreed(input, state)
  return { failed: recordedFailed || orphanFailed, freed: state.freed }
}
