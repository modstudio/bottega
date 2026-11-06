// concern: Goose ledger retention
/** Backfills durable Goose context profiles, then reclaims expired raw copies. */

import type { Database } from 'bun:sqlite'
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { GOOSE_LEDGER_KEEP_DAYS } from '../run/run-artifact-limits.ts'
import { RUNS_DIR } from '../run/run-artifacts.ts'
import { type GooseContextProfile, writeRunContextProfile } from '../run/run-context-profile.ts'
import { enqueueRunRecord } from '../run/run-outbox.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import { STORAGE_WALK_ENTRY_LIMIT, walkStoragePaths } from '../storage-walk.ts'
import { gooseContextProfile } from '../transport/transport-goose-context-profile.ts'

export type GooseLedgerSweepDecision = 'keep' | 'extract-remove' | 'remove'

/** Decide retention from already-observed age and row facts. */
export function decideGooseLedgerSweep(input: {
  olderThanWindow: boolean
  walkComplete: boolean
  rowExists: boolean
  rowTerminal: boolean
  profilePresent: boolean
}): GooseLedgerSweepDecision {
  if (!input.olderThanWindow || !input.walkComplete) return 'keep'
  if (!input.rowExists) return 'remove'
  if (!input.rowTerminal) return 'keep'
  return input.profilePresent ? 'remove' : 'extract-remove'
}

/** A copy whose sources yielded no profile is the last copy of them, so it stays and is reported. */
export function removeAfterExtraction(input: {
  profileFound: boolean
  sourcePresent: boolean
}): boolean {
  return input.profileFound || !input.sourcePresent
}

type ProfileRow = {
  record_id: string
  status: string
  context_system_chars: number | null
  context_tool_count: number | null
  context_tool_schema_chars: number | null
  context_compactions: number | null
  context_cache_read_tokens: number | null
}

function rowProfilePresent(row: ProfileRow): boolean {
  return [
    row.context_system_chars,
    row.context_tool_count,
    row.context_tool_schema_chars,
    row.context_compactions,
    row.context_cache_read_tokens,
  ].some((value) => value !== null)
}

function writeProfile(database: Database, runId: string, profile: GooseContextProfile): void {
  writeTransaction(() => {
    writeRunContextProfile(database, runId, profile)
    enqueueRunRecord(database, runId, machineId(), new Date().toISOString())
  }, database)
}

const PROFILE_SOURCE = /^(?:logs\/llm_request\.[^/]+\.jsonl|sessions\/sessions\.db)$/

function walkLedger(path: string) {
  const walked = walkStoragePaths(
    [path],
    (_root, relativePath) => {
      try {
        return { relativePath, mtimeMs: lstatSync(join(path, relativePath)).mtimeMs }
      } catch {
        return { relativePath, mtimeMs: null }
      }
    },
    STORAGE_WALK_ENTRY_LIMIT,
  )
  const times = walked.observations.flatMap((entry) =>
    entry.mtimeMs === null ? [] : [entry.mtimeMs],
  )
  return {
    bytes: walked.observations.reduce((total, entry) => total + entry.bytes, 0),
    newestMs: times.length > 0 ? Math.max(...times) : null,
    complete: !walked.stoppedAtLimit && walked.errors.length === 0 && !walked.unreadable,
    sourcePresent: walked.observations.some((entry) => PROFILE_SOURCE.test(entry.relativePath)),
  }
}

export type GooseLedgerSweepResult = {
  bytes: number
  removed: number
  extracted: number
  failed: number
}

function sweepOneGooseLedger(input: {
  dryRun: boolean
  cutoff: number
  database: Database
  runId: string
  gooseDir: string
}): Omit<GooseLedgerSweepResult, 'failed'> | 'unextracted' | null {
  const stat = lstatSync(input.gooseDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null
  const ledger = walkLedger(input.gooseDir)
  const row = input.database
    .query<ProfileRow, [string]>(
      `SELECT record_id, status, context_system_chars, context_tool_count, context_tool_schema_chars,
              context_compactions, context_cache_read_tokens
         FROM run WHERE record_id=?`,
    )
    .get(input.runId)
  const decision = decideGooseLedgerSweep({
    olderThanWindow: (ledger.newestMs ?? stat.mtimeMs) < input.cutoff,
    walkComplete: ledger.complete,
    rowExists: row !== null,
    rowTerminal: row !== null && TERMINAL_RUN_STATUS_SET.has(row.status),
    profilePresent: row !== null && rowProfilePresent(row),
  })
  if (decision === 'keep') return null
  const profile = decision === 'extract-remove' ? gooseContextProfile(input.gooseDir) : null
  if (
    decision === 'extract-remove' &&
    !removeAfterExtraction({ profileFound: profile !== null, sourcePresent: ledger.sourcePresent })
  ) {
    return 'unextracted'
  }
  if (profile !== null && !input.dryRun) writeProfile(input.database, input.runId, profile)
  if (!input.dryRun) rmSync(input.gooseDir, { recursive: true, force: true })
  return { bytes: ledger.bytes, removed: 1, extracted: profile === null ? 0 : 1 }
}

/** Sweep-owned filesystem adapter. Each profile and its hosted outbox update commit before removal. */
export function sweepGooseLedgers(input: {
  dryRun: boolean
  now?: number
  runsDir?: string
  database?: Database
  onError?: (message: string) => void
}): GooseLedgerSweepResult {
  const result: GooseLedgerSweepResult = { bytes: 0, removed: 0, extracted: 0, failed: 0 }
  const runsDir = input.runsDir ?? RUNS_DIR
  const database = input.database ?? (input.dryRun ? db() : writableDb())
  const cutoff = (input.now ?? Date.now()) - GOOSE_LEDGER_KEEP_DAYS * 86_400_000
  if (!existsSync(runsDir)) return result
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !hasRecordIdShape(entry.name)) continue
    const gooseDir = join(runsDir, entry.name, 'goose')
    if (!existsSync(gooseDir)) continue
    try {
      const swept = sweepOneGooseLedger({
        dryRun: input.dryRun,
        cutoff,
        database,
        runId: entry.name,
        gooseDir,
      })
      if (swept === 'unextracted') {
        result.failed++
        input.onError?.(`Goose ledger kept: no context profile could be read from ${gooseDir}`)
      } else if (swept) {
        result.bytes += swept.bytes
        result.removed += swept.removed
        result.extracted += swept.extracted
      }
    } catch (cause) {
      result.failed++
      input.onError?.(`Goose ledger sweep failed for ${gooseDir}: ${String(cause)}`)
    }
  }
  return result
}
