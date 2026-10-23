// concern: scheduled run-store leftover cleanup adapter
/** Inventories run-owned directories, applies the leftover policy, and reports measured removal. */

import type { Database } from 'bun:sqlite'
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { releaseSandboxDirectoryForConversation } from '../close/close-out.ts'
import { db } from '../database/db.ts'
import { chainScoreJoin, EVIDENCE_CLOSED_SQL } from '../evidence/evidence-query.ts'
import { noRepoIsolatePath, RUNS_DIR, runArtifactsDir } from '../run/run-artifacts.ts'
import { chainTerminationAtForRoot } from '../run/run-chain.ts'
import { runSandboxDir, runScratchDir } from '../run-owned-paths.ts'
import { STORAGE_WALK_ENTRY_LIMIT, walkStoragePaths } from '../storage-walk.ts'
import type { CleanupPresentation } from './cleanup.ts'
import {
  decideRunLeftover,
  type RunLeftoverDecision,
  type RunLeftoverKeepReason,
  type RunLeftoverKind,
} from './run-leftover-decision.ts'
import { renderUnjudgedRunRemedy, type UnjudgedRunRemedy } from './unjudged-run-remedy.ts'

type RunRow = {
  record_id: string
  number: number
  root_number: number
  parent_run_record_id: string | null
  status: string
  project_record_id: string | null
  judged: number
  root_failure_kind: string | null
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

type Candidate = {
  path: string
  kind: RunLeftoverKind
  runRecordId: string | null
  runNumber: number | null
  remedyRunNumber?: number
  decision: RunLeftoverDecision
  measurement?: Measurement
}

export const RUN_LEFTOVER_REPORT_EXAMPLES = 5

export type KeptRunLeftover = {
  path: string
  kind: RunLeftoverKind
  runNumber: number | null
  remedyRunNumber?: number
  reason: RunLeftoverKeepReason
  status?: string
  detail?: string
  bytes: number
  complete: boolean
  remedy?: UnjudgedRunRemedy
}

type KeptGroup = readonly KeptRunLeftover[]

function keptNoun(items: KeptGroup): string {
  const kinds = new Set(items.map((item) => item.kind))
  if (kinds.size !== 1) return 'run leftovers'
  const plural = items.length === 1 ? '' : 's'
  switch (items[0]!.kind) {
    case 'scratch':
      return `run scratch director${plural ? 'ies' : 'y'}`
    case 'sandbox':
      return `run sandbox${plural === '' ? '' : 'es'}`
    case 'isolate':
      return `run isolate${plural}`
    case 'artifacts':
      return `run artifact${plural}`
    case 'orphan':
      return `orphan run director${plural ? 'ies' : 'y'}`
  }
}

function keptGroupLines(
  reason: RunLeftoverKeepReason,
  items: KeptGroup,
  verbose: boolean,
): string[] {
  const remedy = [
    ...new Set(
      items.flatMap((item) =>
        item.remedy ? [renderUnjudgedRunRemedy(item.remedy, item.remedyRunNumber ?? '<n>')] : [],
      ),
    ),
  ].map((command) => `  ${command}`)
  if (verbose)
    return [
      ...items.map(
        (item) => `kept ${item.kind} ${item.path}: ${keptReasonClause(item.reason, item, true)}`,
      ),
      ...remedy,
    ]
  const bytes = items.reduce((total, item) => total + item.bytes, 0)
  const qualifier = items.every((item) => item.complete) ? '' : 'at least '
  const usesRunNumbers = items.every((item) => item.remedy !== undefined && item.runNumber !== null)
  const examples = items
    .slice(0, RUN_LEFTOVER_REPORT_EXAMPLES)
    .map((item) => (usesRunNumbers ? String(item.runNumber) : item.path))
  const more = items.length - examples.length
  return [
    `kept ${items.length} ${keptNoun(items)} ${keptReasonClause(reason, items[0]!, false)} (${qualifier}${bytes} bytes); example ${usesRunNumbers ? 'runs' : 'paths'}: ${examples.join(', ')}${more > 0 ? `; and ${more} more` : ''}`,
    ...remedy,
  ]
}

function keptReasonClause(
  reason: RunLeftoverKeepReason,
  item: KeptRunLeftover,
  verbose: boolean,
): string {
  switch (reason) {
    case 'live':
      return `live${verbose ? ` (${item.status ?? 'unknown'})` : ''}`
    case 'recently finished':
      return 'not older than the run leftover age cap'
    case 'finish time unknown':
      return 'whose run finish time could not be established'
    case 'no recorded verdict':
      return 'with no recorded verdict'
    case 'orphan age unknown':
      return `whose age could not be established${verbose && item.detail ? `: ${item.detail}` : ''}`
    case 'young orphan':
      return 'not older than the run leftover age cap'
    case 'sandbox held':
      return `held by the sandbox release decision${verbose && item.detail ? `: ${item.detail}` : ''}`
  }
}

/** Format measured policy-kept candidates without knowing the filesystem or presentation. */
export function keptRunLeftoverLines(kept: readonly KeptRunLeftover[], verbose: boolean): string[] {
  const groups = new Map<RunLeftoverKeepReason, KeptRunLeftover[]>()
  for (const item of kept) {
    const group = groups.get(item.reason) ?? []
    group.push(item)
    groups.set(item.reason, group)
  }
  return [...groups].flatMap(([reason, items]) => keptGroupLines(reason, items, verbose))
}

function removeCandidate(
  candidate: Candidate,
  dryRun: boolean,
  remove: SweepInput['remove'],
):
  | { action: 'removed' }
  | { action: 'kept'; reason: 'sandbox held'; detail: string }
  | { action: 'failed'; detail: string } {
  if (remove) {
    remove(candidate, dryRun)
    return { action: 'removed' }
  }
  if (candidate.kind === 'sandbox') {
    const result = releaseSandboxDirectoryForConversation(candidate.runRecordId!, { dryRun })
    if (result.outcome !== 'kept') return { action: 'removed' }
    if (result.detail.startsWith('sandbox directory removal failed:'))
      return { action: 'failed', detail: result.detail }
    return { action: 'kept', reason: 'sandbox held', detail: result.detail }
  }
  if (!dryRun) rmSync(candidate.path, { recursive: true })
  return { action: 'removed' }
}

function applyCandidate(
  candidate: Candidate,
  dryRun: boolean,
  presentation: CleanupPresentation,
  freed: Record<RunLeftoverKind, number>,
  partial: Set<RunLeftoverKind>,
  kept: KeptRunLeftover[],
  remove: SweepInput['remove'],
): boolean {
  const state = directoryPresent(candidate.path)
  if (!state.present) {
    return false
  }
  if (state.reason) {
    presentation.log(`kept ${candidate.kind} ${candidate.path}: ${state.reason}`)
    return false
  }
  if (candidate.decision.action === 'keep') {
    const measurement = candidate.measurement ?? measure(candidate.path, false)
    kept.push({
      path: candidate.path,
      kind: candidate.kind,
      runNumber: candidate.runNumber,
      reason: candidate.decision.reason,
      status: candidate.decision.status,
      detail: candidate.decision.detail,
      bytes: measurement.bytes,
      complete: measurement.complete,
      remedy: candidate.decision.remedy,
      remedyRunNumber: candidate.remedyRunNumber,
    })
    return false
  }
  const measurement = candidate.measurement ?? measure(candidate.path, false)
  if (!measurement.complete) partial.add(candidate.kind)
  try {
    const removal = removeCandidate(candidate, dryRun, remove)
    if (removal.action === 'kept') {
      kept.push({
        path: candidate.path,
        kind: candidate.kind,
        runNumber: candidate.runNumber,
        reason: removal.reason,
        detail: removal.detail,
        bytes: measurement.bytes,
        complete: measurement.complete,
      })
      return false
    }
    if (removal.action === 'failed') {
      presentation.log(`kept ${candidate.kind} ${candidate.path}: ${removal.detail}`)
      return true
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
      `SELECT r.record_id,r.number,r.parent_run_record_id,r.status,r.project_record_id,
              root.number AS root_number,root.failure_kind AS root_failure_kind,
              ${EVIDENCE_CLOSED_SQL} AS judged
         FROM run r
         JOIN run root ON root.record_id=COALESCE(r.parent_run_record_id,r.record_id)
         ${chainScoreJoin('r', 's')}
        WHERE ? IS NULL OR r.project_record_id=?
        ORDER BY r.number`,
    )
    .all(projectRecordId, projectRecordId) as RunRow[]
}

type SweepInput = {
  dryRun: boolean
  verbose?: boolean
  projectRecordId: string | null
  presentation: CleanupPresentation
  clock?: number
  database?: Database
  runsDir?: string
  evidenceClosedRootIds?: ReadonlySet<string>
  remove?: (
    candidate: {
      path: string
      kind: RunLeftoverKind
      runRecordId: string | null
      runNumber: number | null
    },
    dryRun: boolean,
  ) => void
}

type SweepState = {
  freed: Record<RunLeftoverKind, number>
  partial: Set<RunLeftoverKind>
  kept: KeptRunLeftover[]
}

function sweepRecordedLeftovers(
  input: SweepInput,
  rows: readonly RunRow[],
  clock: number,
  state: SweepState,
): boolean {
  const runsDir = input.runsDir ?? RUNS_DIR
  const terminationByRoot = new Map<string, number | null>()
  let failed = false
  for (const row of rows) {
    const rootId = row.parent_run_record_id ?? row.record_id
    if (!terminationByRoot.has(rootId)) {
      const termination = chainTerminationAtForRoot(input.database ?? db(), rootId)
      const timestamp = termination === null ? Number.NaN : Date.parse(termination)
      terminationByRoot.set(rootId, Number.isFinite(timestamp) ? timestamp : null)
    }
    const facts = {
      runStatus: row.status,
      finishedAt: terminationByRoot.get(rootId) ?? null,
      judged: Boolean(row.judged) || (input.evidenceClosedRootIds?.has(rootId) ?? false),
      failureKind: row.root_failure_kind,
      newestEntryAt: null,
      clock,
    }
    for (const [kind, path] of [
      ['scratch', runScratchDir(row.record_id, runsDir)],
      ['isolate', noRepoIsolatePath(row.record_id, runsDir)],
      ['artifacts', runArtifactsDir(row.record_id, runsDir)],
    ] as const) {
      const candidateFailed = applyCandidate(
        {
          path,
          kind,
          runRecordId: row.record_id,
          runNumber: row.number,
          remedyRunNumber: row.root_number,
          decision: decideRunLeftover({ kind, ...facts }),
        },
        input.dryRun,
        input.presentation,
        state.freed,
        state.partial,
        state.kept,
        input.remove,
      )
      failed ||= candidateFailed
    }
    if (rootId !== row.record_id) continue
    const sandboxFailed = applyCandidate(
      {
        path: runSandboxDir(rootId, runsDir),
        kind: 'sandbox',
        runRecordId: rootId,
        runNumber: row.number,
        decision: decideRunLeftover({
          kind: 'sandbox',
          runStatus: row.status,
          finishedAt: facts.finishedAt,
          judged: facts.judged,
          failureKind: row.root_failure_kind,
          newestEntryAt: null,
          clock,
        }),
      },
      input.dryRun,
      input.presentation,
      state.freed,
      state.partial,
      state.kept,
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
      failureKind: null,
      newestEntryAt: measurement.complete ? measurement.newestEntryAt : null,
      clock,
    })
    const ruling = measurement.complete
      ? decision
      : {
          action: 'keep' as const,
          reason: 'orphan age unknown' as const,
          detail: measurement.detail ?? 'storage walk was incomplete',
        }
    const orphanFailed = applyCandidate(
      {
        path,
        kind: 'orphan',
        runRecordId: null,
        runNumber: null,
        decision: ruling,
        measurement,
      },
      input.dryRun,
      input.presentation,
      state.freed,
      state.partial,
      state.kept,
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
    kept: [],
  }
  const recordedFailed = sweepRecordedLeftovers({ ...input, database }, rows, clock, state)
  const orphanFailed = sweepOrphans(input, rows, clock, state)
  for (const line of keptRunLeftoverLines(state.kept, input.verbose ?? false))
    input.presentation.log(line)
  reportFreed(input, state)
  return { failed: recordedFailed || orphanFailed, freed: state.freed }
}
