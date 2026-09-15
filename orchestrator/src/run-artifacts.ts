// concern: run-artifacts
/**
 * Knows run file paths, snapshots, artifact persistence, and the
 * snapshot-versus-database reconciliation protocol. Must not know routing,
 * contracts, transports, reviews, or worktree isolation.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative } from 'node:path'
import { resolveRunsDirectory } from './database-location.ts'
import { db, writableDb, writeTransaction } from './db.ts'
import { CONNECTION_SCHEMA_INVARIANT } from './migrations.ts'
import { teardownTerminalRunResources } from './resource-ownership.ts'

/**
 * How long a run's prompt and reply are kept on disk.
 *
 * These files are the whole text of every pack sent and every answer returned —
 * private repo contents, quoted at length — and nothing had ever deleted one.
 * The dashboard reads them to show a run in full, which is worth having while
 * the run is recent enough for anyone to care; a pack from two months ago is
 * just a copy of source code sitting outside the repo that governs it.
 *
 * The database keeps the row either way, so history and scoring are untouched:
 * only the verbatim text ages out, and `runDetail` already copes with a path
 * that no longer exists.
 */
export const KEEP_RUN_FILES_DAYS = 30

/**
 * Where prompt and output files live. By default they sit beside the resolved
 * database, so a worktree cannot strand its evidence when it is swept.
 * ORCH_RUNS remains the deliberate override used by the suite.
 */
export const RUNS_DIR = resolveRunsDirectory()

/** The names owned by one run; `unique` is its id once a row has been claimed. */
export function runFilePaths(
  dir: string,
  clock: number,
  unique: number | string,
  agent: string,
  jobName: string,
) {
  const stamp = `${clock}-${unique}-${agent}-${jobName}`
  return {
    output: join(dir, `${stamp}.txt`),
    prompt: join(dir, `${stamp}.prompt.txt`),
  }
}

/** Opportunistic, on the way past: cheap, and no cron has to remember. */
export function pruneRuns(dir: string): void {
  const cutoff = Date.now() - KEEP_RUN_FILES_DAYS * 86_400_000
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.mtimeMs < cutoff) {
          if (st.isDirectory()) rmSync(p, { recursive: true, force: true })
          else unlinkSync(p)
          db().query('UPDATE run SET prompt_path=NULL WHERE prompt_path=?').run(p)
          db().query('UPDATE run SET output_path=NULL WHERE output_path=?').run(p)
        }
      } catch {
        /* raced, or busy */
      }
    }
  } catch {
    /* no directory yet; nothing to prune */
  }
}

export function runScratchDir(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, String(id), 'scratch')
}

export function noRepoIsolatePath(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, 'isolates', String(id))
}

export function runArtifactsDir(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, String(id), 'artifacts')
}

export function declaredDeliverablesPath(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, String(id), 'deliverables.json')
}

export function runTerminalResultPath(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, String(id), 'result.json')
}

export function runTerminalReplyPath(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, String(id), 'reply.txt')
}

export type TerminalSnapshot = {
  status: string
  error: string | null
  failureKind: string | null
  output: string
  outputPath: string
  promptPath: string
  exitCode: number | null
  latencyMs: number
  vendorTokens: number | null
  vendorCostUsd: number | null
  model: string | null
  vendorSession: string | null
  preConfinement: string | null
  confinement: string | null
  filesChanged: number | null
  changedPaths: string | null
  linesAdded: number | null
  linesRemoved: number | null
  testsRan: number | null
  testsPassed: number | null
  deviations: number | null
  escalations: number | null
}

export function persistTerminalSnapshot(id: number, snapshot: TerminalSnapshot): void {
  mkdirSync(join(RUNS_DIR, String(id)), { recursive: true })
  writeFileSync(runTerminalReplyPath(id), snapshot.output)
  writeFileSync(runTerminalResultPath(id), JSON.stringify(snapshot))
}

export function readTerminalSnapshot(id: number): TerminalSnapshot | null {
  const path = runTerminalResultPath(id)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TerminalSnapshot
  } catch {
    return null
  }
}

/** Record a terminal row from the run directory after a schema-reload failure. */
export function reconcileRun(id: number): string {
  writableDb()
  const snapshot = readTerminalSnapshot(id)
  if (!snapshot) {
    throw new Error(
      `run ${id} has no persisted terminal snapshot\n` +
        `invariant: ${CONNECTION_SCHEMA_INVARIANT}\n` +
        `cleared by: the worker must persist reply.txt and result.json before the row write`,
    )
  }
  const row = db().query('SELECT id, unreconciled, status FROM run WHERE id=?').get(id) as {
    id: number
    unreconciled: number
    status: string
  } | null
  if (!row) throw new Error(`no run ${id}`)
  /**
   * Reconciliation can restore an `asking` status only because question rows
   * are inserted before the journalled terminal write. The snapshot carries no
   * question payload. Making those inserts part of the terminal transaction
   * therefore requires first making questions recoverable from this journal,
   * or a failed transaction could reconcile to `asking` with nothing to answer.
   */
  writeTransaction(() => {
    db()
      .query(
        `UPDATE run SET latency_ms=?, exit_code=?, output_bytes=?, output_path=?, prompt_path=?,
                      vendor_tokens=?, vendor_cost_usd=?, model=COALESCE(?, model),
                      status=?, error=?, failure_kind=?, vendor_session=COALESCE(?, vendor_session),
                      pre_confinement=?, confinement=?, unreconciled=0,
                      files_changed=?, changed_paths=?, lines_added=?, lines_removed=?,
                      tests_ran=?, tests_passed=?, deviations=?, escalations=?
        WHERE id=?`,
      )
      .run(
        snapshot.latencyMs,
        snapshot.exitCode,
        new TextEncoder().encode(snapshot.output).byteLength,
        snapshot.outputPath,
        snapshot.promptPath,
        snapshot.vendorTokens,
        snapshot.vendorCostUsd,
        snapshot.model,
        snapshot.status,
        snapshot.error,
        snapshot.failureKind,
        snapshot.vendorSession,
        snapshot.preConfinement,
        snapshot.confinement,
        snapshot.filesChanged,
        snapshot.changedPaths,
        snapshot.linesAdded,
        snapshot.linesRemoved,
        snapshot.testsRan,
        snapshot.testsPassed,
        snapshot.deviations,
        snapshot.escalations,
        id,
      )
  })
  teardownTerminalRunResources(db(), id)
  return `reconciled run ${id} as ${snapshot.status}`
}

export function listRunArtifacts(id: number, runsDir = RUNS_DIR): string[] {
  const dir = runArtifactsDir(id, runsDir)
  if (!existsSync(dir)) return []
  const names = readdirSync(dir, { recursive: true })
  const files: string[] = []
  for (const name of names) {
    const p = join(dir, String(name))
    try {
      if (statSync(p).isFile()) files.push(p)
    } catch {
      /* raced */
    }
  }
  return files.sort()
}

export type DispatchState = { deliverables: string[]; timeoutMinutes: number | null }

export function writeDispatchState(id: number, state: DispatchState): void {
  mkdirSync(join(RUNS_DIR, String(id)), { recursive: true })
  writeFileSync(declaredDeliverablesPath(id), JSON.stringify(state))
}

export function readDispatchState(id: number): DispatchState {
  const p = declaredDeliverablesPath(id)
  if (!existsSync(p)) return { deliverables: [], timeoutMinutes: null }
  try {
    const value = JSON.parse(readFileSync(p, 'utf8')) as Partial<DispatchState> | string[]
    if (Array.isArray(value)) {
      return {
        deliverables: value.every((item) => typeof item === 'string') ? value : [],
        timeoutMinutes: null,
      }
    }
    const deliverables =
      Array.isArray(value.deliverables) &&
      value.deliverables.every((item) => typeof item === 'string')
        ? value.deliverables
        : []
    const timeoutMinutes = typeof value.timeoutMinutes === 'number' ? value.timeoutMinutes : null
    return { deliverables, timeoutMinutes }
  } catch {
    return { deliverables: [], timeoutMinutes: null }
  }
}

export function readDeclaredDeliverables(id: number): string[] {
  return readDispatchState(id).deliverables
}

export function persistRunArtifacts(
  id: number,
  filesWritten: string[] | null,
  worktree: { path: string } | null,
  changes: { diff?: string } | null,
): void {
  const scratch = runScratchDir(id)
  const artifacts = runArtifactsDir(id)
  mkdirSync(join(RUNS_DIR, String(id)), { recursive: true })
  if (existsSync(scratch)) {
    if (existsSync(artifacts)) rmSync(artifacts, { recursive: true, force: true })
    renameSync(scratch, artifacts)
  } else {
    mkdirSync(artifacts, { recursive: true })
  }
  if (changes?.diff) writeFileSync(join(artifacts, 'worktree.diff'), changes.diff)
  for (const named of filesWritten ?? []) {
    const source = named.startsWith('/') ? named : worktree ? join(worktree.path, named) : named
    const destination = join(artifacts, basename(named))
    // Scratch was renamed onto artifacts above. A files_written path that still
    // names the old scratch location (reply.json is the usual case) already
    // lives at the destination.
    const from =
      source === scratch || source.startsWith(`${scratch}/`)
        ? join(artifacts, relative(scratch, source))
        : source
    if (from === destination && existsSync(destination) && statSync(destination).isFile()) continue
    if (!existsSync(from) || !statSync(from).isFile()) {
      throw new Error(`could not copy named file ${source} to ${destination}: source is not a file`)
    }
    copyFileSync(from, destination)
  }
}
