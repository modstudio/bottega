// concern: run-artifacts
/**
 * Knows run file paths, snapshots, artifact persistence, and the
 * snapshot-versus-database reconciliation protocol. Must not know routing,
 * contracts, transports, reviews, or worktree isolation.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  runArtifactsDir as artifactDirectory,
  isPathAtOrBelow,
  namedArtifactPlan,
  runScratchDir as scratchDirectory,
} from '../artifact-paths.ts'
import { resolveRunsDirectory } from '../database/database-location.ts'
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { CONNECTION_SCHEMA_INVARIANT } from '../database/migrations.ts'
import { teardownTerminalRunResources } from '../resources/resource-ownership.ts'
import {
  decideRunArtifactRetention,
  OUTSIDE_DEPTH_AGGREGATE_FILE_LIMIT,
  RUN_ARTIFACT_BUILD_OUTPUT_DIRECTORIES,
  RUN_ARTIFACT_FILE_CAP_BYTES,
  RUN_ARTIFACT_TOTAL_CAP_BYTES,
  type RunArtifactListingEntry,
} from './run-artifact-retention.ts'

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
export {
  OUTSIDE_DEPTH_AGGREGATE_FILE_LIMIT,
  RUN_ARTIFACT_BUILD_OUTPUT_DIRECTORIES,
  RUN_ARTIFACT_FILE_CAP_BYTES,
  RUN_ARTIFACT_TOTAL_CAP_BYTES,
}

/**
 * Where prompt and output files live. By default they sit beside the resolved
 * database, so a worktree cannot strand its evidence when it is swept.
 * ORCH_RUNS remains the deliberate override used by the suite.
 */
export const RUNS_DIR = resolveRunsDirectory(process.env)

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

export function writeGeneratedSchema(
  runsDir: string,
  stamp: string,
  generatedSchema: unknown,
  callerSchemaPath: string | undefined,
): string | undefined {
  if (!generatedSchema || callerSchemaPath) return callerSchemaPath
  const path = join(runsDir, `${stamp}.schema.json`)
  writeFileSync(path, JSON.stringify(generatedSchema, null, 2))
  return path
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

export const runScratchDir = (id: number, runsDir = RUNS_DIR): string =>
  scratchDirectory(id, runsDir)

export function noRepoIsolatePath(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, 'isolates', String(id))
}

export const runArtifactsDir = (id: number, runsDir = RUNS_DIR): string =>
  artifactDirectory(id, runsDir)

function declaredDeliverablesPath(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, String(id), 'deliverables.json')
}

function runTerminalResultPath(id: number, runsDir = RUNS_DIR): string {
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

function readTerminalSnapshot(id: number): TerminalSnapshot | null {
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

type ListedArtifact = RunArtifactListingEntry & { source: string }

function listArtifacts(source: string, logical: string, listed: Map<string, ListedArtifact>): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) {
    listed.set(logical, {
      path: logical,
      kind: 'symlink',
      size: stat.size,
      linkText: readlinkSync(source),
      source,
    })
    return
  }
  if (stat.isFile()) {
    listed.set(logical, { path: logical, kind: 'file', size: stat.size, source })
    return
  }
  if (!stat.isDirectory()) return
  listed.set(logical, { path: logical, kind: 'directory', size: stat.size, source })
  for (const name of readdirSync(source))
    listArtifacts(join(source, name), logical ? `${logical}/${name}` : name, listed)
}

function citedRunPaths(reply: string, scratch: string, artifacts: string): string[] {
  const paths: string[] = []
  for (const root of [scratch, artifacts]) {
    let cursor = 0
    while (cursor >= 0) {
      cursor = reply.indexOf(root, cursor)
      if (cursor < 0) break
      let end = cursor + root.length
      while (end < reply.length && !/[\s"'`<>]/.test(reply[end]!)) end++
      paths.push(reply.slice(cursor, end).replace(/[),.;:]+$/, ''))
      cursor = end
    }
  }
  return paths
}

function recordArtifactByteTotals(id: number, keptBytes: number, droppedBytes: number): void {
  const path = runTerminalResultPath(id)
  if (!existsSync(path)) return
  const result = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  result.artifactBytesKept = keptBytes
  result.artifactBytesDropped = droppedBytes
  writeFileSync(path, JSON.stringify(result))
}

export function persistRunArtifacts(
  id: number,
  filesWritten: string[] | null,
  worktree: { path: string } | null,
  changes: { diff?: string } | null,
  reply = '',
): void {
  const scratch = runScratchDir(id)
  const artifacts = runArtifactsDir(id)
  const runDirectory = join(RUNS_DIR, String(id))
  mkdirSync(runDirectory, { recursive: true })
  const listed = new Map<string, ListedArtifact>()
  if (existsSync(artifacts)) {
    for (const name of readdirSync(artifacts)) {
      if (name !== 'dropped.json') listArtifacts(join(artifacts, name), name, listed)
    }
  }
  if (existsSync(scratch)) {
    for (const name of readdirSync(scratch)) listArtifacts(join(scratch, name), name, listed)
  }
  const failures: string[] = []
  const namedLogical: string[] = []
  for (const named of [...(filesWritten ?? []), ...citedRunPaths(reply, scratch, artifacts)]) {
    const artifact = namedArtifactPlan(id, RUNS_DIR, named, worktree?.path ?? null)
    const logical = relative(artifacts, artifact.destination)
    if (namedLogical.includes(logical)) continue
    namedLogical.push(logical)
    try {
      const source = isPathAtOrBelow(named, scratch) ? named : artifact.source
      if (!existsSync(source)) throw new Error('source does not exist')
      if (!artifact.alreadyInPlace && !isPathAtOrBelow(source, scratch)) {
        listArtifacts(source, logical, listed)
      }
    } catch (error) {
      failures.push(
        `could not copy named file ${artifact.source} to ${artifact.destination}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (failures.length > 0) throw new Error(failures.join('\n'))
  if (changes?.diff) {
    listed.set('worktree.diff', {
      path: 'worktree.diff',
      kind: 'file',
      size: Buffer.byteLength(changes.diff),
      source: '',
    })
  }
  const plan = decideRunArtifactRetention([...listed.values()], namedLogical)
  const stage = mkdtempSync(join(runDirectory, '.artifacts-'))
  try {
    for (const kept of plan.kept) {
      const entry = listed.get(kept)!
      const destination = join(stage, kept)
      mkdirSync(dirname(destination), { recursive: true })
      if (kept === 'worktree.diff' && changes?.diff) writeFileSync(destination, changes.diff)
      else copyFileSync(entry.source, destination)
    }
    writeFileSync(join(stage, 'dropped.json'), JSON.stringify(plan.dropped, null, 2))
    rmSync(artifacts, { recursive: true, force: true })
    renameSync(stage, artifacts)
    rmSync(scratch, { recursive: true, force: true })
    recordArtifactByteTotals(id, plan.keptBytes, plan.droppedBytes)
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}
