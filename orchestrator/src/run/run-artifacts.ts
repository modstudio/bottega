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
import type { FilesystemIdentityPlan, FilesystemIdentityRun } from '../filesystem-identity-plan.ts'
import { teardownTerminalRunResources } from '../resources/resource-ownership.ts'
import { KEEP_RUN_FILES_DAYS } from './run-artifact-limits.ts'
import {
  decideRunArtifactRetention,
  namedRunArtifactPaths,
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
export { KEEP_RUN_FILES_DAYS } from './run-artifact-limits.ts'
export { namedRunArtifactPaths }

/**
 * Where prompt and output files live. By default they sit beside the resolved
 * database, so a worktree cannot strand its evidence when it is swept.
 * ORCH_RUNS remains the deliberate override used by the suite.
 */
export const RUNS_DIR = resolveRunsDirectory(process.env)

function legacyRunDirectory(name: string): { number: string; sandbox: boolean } | null {
  const sandbox = /^sandbox-([1-9]\d*)$/.exec(name)?.[1]
  if (sandbox) return { number: sandbox, sandbox: true }
  return /^[1-9]\d*$/.test(name) ? { number: name, sandbox: false } : null
}

function runDirectoryName(recordId: string, sandbox = false): string {
  return sandbox ? `sandbox-${recordId}` : recordId
}

export type RunArtifactMigrationCandidate = {
  name: string
  directory: boolean
  destinationExists: boolean
}

/** Purely classify legacy artifact directories; filesystem discovery happens once upstream. */
export function planRunArtifactMigration(
  runsDirectory: string,
  candidates: readonly RunArtifactMigrationCandidate[],
  runs: ReadonlyMap<string, FilesystemIdentityRun>,
): FilesystemIdentityPlan {
  const plan: FilesystemIdentityPlan = { mapped: [], collisions: [], unmapped: [] }
  for (const candidate of candidates) {
    const legacy = candidate.directory ? legacyRunDirectory(candidate.name) : null
    if (!legacy) continue
    const source = join(runsDirectory, candidate.name)
    const run = runs.get(legacy.number)
    if (!run) {
      plan.unmapped.push({ source, number: legacy.number })
      continue
    }
    const move = {
      source,
      destination: join(runsDirectory, runDirectoryName(run.recordId, legacy.sandbox)),
      run,
      payload: undefined,
    }
    ;(candidate.destinationExists ? plan.collisions : plan.mapped).push(move)
  }
  return plan
}

export function discoverRunArtifactMigration(
  runsDirectory: string,
  runs: ReadonlyMap<string, FilesystemIdentityRun>,
): FilesystemIdentityPlan {
  if (!existsSync(runsDirectory)) return { mapped: [], collisions: [], unmapped: [] }
  const entries = readdirSync(runsDirectory, { withFileTypes: true })
  return planRunArtifactMigration(
    runsDirectory,
    entries.map((entry) => {
      const legacy = entry.isDirectory() ? legacyRunDirectory(entry.name) : null
      const run = legacy ? runs.get(legacy.number) : undefined
      return {
        name: entry.name,
        directory: entry.isDirectory(),
        destinationExists: Boolean(
          run && existsSync(join(runsDirectory, runDirectoryName(run.recordId, legacy!.sandbox))),
        ),
      }
    }),
    runs,
  )
}

export function applyRunArtifactMigration(plan: FilesystemIdentityPlan): number {
  for (const move of plan.mapped) renameSync(move.source, move.destination)
  return plan.mapped.length
}

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

export const runScratchDir = (id: string, runsDir = RUNS_DIR): string =>
  scratchDirectory(id, runsDir)

export function prepareFiles(
  runsDir: string,
  recordId: string,
  claimedPrompt: string | null,
  originalPrompt: string,
) {
  const runDirectory = join(runsDir, recordId)
  mkdirSync(runDirectory, { recursive: true })
  const paths = {
    promptPath: claimedPrompt ?? join(runDirectory, 'prompt.txt'),
    outputPath: join(runDirectory, 'output.txt'),
  }
  writeFileSync(paths.promptPath, originalPrompt)
  return paths
}

export function noRepoIsolatePath(id: string, runsDir = RUNS_DIR): string {
  return join(runsDir, 'isolates', id)
}

export function runSandboxDir(id: string, runsDir = RUNS_DIR): string {
  return join(runsDir, `sandbox-${id}`)
}

export const runArtifactsDir = (id: string, runsDir = RUNS_DIR): string =>
  artifactDirectory(id, runsDir)

function declaredDeliverablesPath(id: string, runsDir = RUNS_DIR): string {
  return join(runsDir, id, 'deliverables.json')
}

function runTerminalResultPath(id: string, runsDir = RUNS_DIR): string {
  return join(runsDir, id, 'result.json')
}

export function runTerminalReplyPath(id: string, runsDir = RUNS_DIR): string {
  return join(runsDir, id, 'reply.txt')
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

export function persistTerminalSnapshot(id: string, snapshot: TerminalSnapshot): void {
  mkdirSync(join(RUNS_DIR, id), { recursive: true })
  writeFileSync(runTerminalReplyPath(id), snapshot.output)
  writeFileSync(runTerminalResultPath(id), JSON.stringify(snapshot))
}

function readTerminalSnapshot(id: string): TerminalSnapshot | null {
  const path = runTerminalResultPath(id)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TerminalSnapshot
  } catch {
    return null
  }
}

/** Record a terminal row from the run directory after a schema-reload failure. */
export function reconcileRun(id: string): string {
  writableDb()
  const snapshot = readTerminalSnapshot(id)
  if (!snapshot) {
    throw new Error(
      `run ${id} has no persisted terminal snapshot\n` +
        `invariant: ${CONNECTION_SCHEMA_INVARIANT}\n` +
        `cleared by: the worker must persist reply.txt and result.json before the row write`,
    )
  }
  const row = db()
    .query('SELECT record_id, unreconciled, status FROM run WHERE record_id=?')
    .get(id) as {
    record_id: string
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
        WHERE record_id=?`,
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

export function writeDispatchState(id: string, state: DispatchState): void {
  mkdirSync(join(RUNS_DIR, id), { recursive: true })
  writeFileSync(declaredDeliverablesPath(id), JSON.stringify(state))
}

export function readDispatchState(id: string): DispatchState {
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

function recordArtifactByteTotals(id: string, keptBytes: number, droppedBytes: number): void {
  const path = runTerminalResultPath(id)
  if (!existsSync(path)) return
  const result = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  result.artifactBytesKept = keptBytes
  result.artifactBytesDropped = droppedBytes
  writeFileSync(path, JSON.stringify(result))
}

type ArtifactCollectionInput = {
  id: string
  scratch: string
  artifacts: string
  namedPaths: string[]
  worktreePath: string | null
  diff?: string
}

function collectNamedCandidates(
  input: ArtifactCollectionInput,
  listed: Map<string, ListedArtifact>,
): { namedLogical: string[]; failures: string[] } {
  const failures: string[] = []
  const namedLogical: string[] = []
  for (const named of input.namedPaths) {
    const failure = collectNamedCandidate(input, named, listed, namedLogical)
    if (failure) failures.push(failure)
  }
  return { namedLogical, failures }
}

function collectNamedCandidate(
  input: ArtifactCollectionInput,
  named: string,
  listed: Map<string, ListedArtifact>,
  namedLogical: string[],
): string | null {
  const artifact = namedArtifactPlan(input.id, RUNS_DIR, named, input.worktreePath)
  const logical = relative(input.artifacts, artifact.destination) || '.'
  if (namedLogical.includes(logical)) return null
  namedLogical.push(logical)
  if (logical === '.') return null
  try {
    const source = isPathAtOrBelow(named, input.scratch) ? named : artifact.source
    if (!existsSync(source)) throw new Error('source does not exist')
    if (!artifact.alreadyInPlace && !isPathAtOrBelow(source, input.scratch)) {
      listArtifacts(source, logical, listed)
    }
    return null
  } catch (error) {
    return `could not copy named file ${artifact.source} to ${artifact.destination}: ${error instanceof Error ? error.message : String(error)}`
  }
}

function collectArtifactCandidates(input: ArtifactCollectionInput): {
  listed: Map<string, ListedArtifact>
  namedLogical: string[]
  failures: string[]
} {
  const listed = new Map<string, ListedArtifact>()
  if (existsSync(input.artifacts)) {
    for (const name of readdirSync(input.artifacts)) {
      if (name !== 'dropped.json') listArtifacts(join(input.artifacts, name), name, listed)
    }
  }
  if (existsSync(input.scratch)) {
    for (const name of readdirSync(input.scratch)) {
      listArtifacts(join(input.scratch, name), name, listed)
    }
  }
  const named = collectNamedCandidates(input, listed)
  if (input.diff) {
    listed.set('worktree.diff', {
      path: 'worktree.diff',
      kind: 'file',
      size: Buffer.byteLength(input.diff),
      source: '',
    })
  }
  return { listed, ...named }
}

function publishRetainedArtifacts(input: {
  id: string
  scratch: string
  artifacts: string
  runDirectory: string
  listed: Map<string, ListedArtifact>
  namedLogical: string[]
  diff?: string
}): void {
  const plan = decideRunArtifactRetention([...input.listed.values()], input.namedLogical)
  const stage = mkdtempSync(join(input.runDirectory, '.artifacts-'))
  try {
    for (const kept of plan.kept) {
      const entry = input.listed.get(kept)!
      const destination = join(stage, kept)
      mkdirSync(dirname(destination), { recursive: true })
      if (kept === 'worktree.diff' && input.diff) writeFileSync(destination, input.diff)
      else copyFileSync(entry.source, destination)
    }
    writeFileSync(join(stage, 'dropped.json'), JSON.stringify(plan.dropped, null, 2))
    rmSync(input.artifacts, { recursive: true, force: true })
    renameSync(stage, input.artifacts)
    rmSync(input.scratch, { recursive: true, force: true })
    recordArtifactByteTotals(input.id, plan.keptBytes, plan.droppedBytes)
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

export function persistRunArtifacts(
  id: string,
  namedPaths: string[] | null,
  worktree: { path: string } | null,
  changes: { diff?: string } | null,
): void {
  const scratch = runScratchDir(id)
  const artifacts = runArtifactsDir(id)
  const runDirectory = join(RUNS_DIR, id)
  mkdirSync(runDirectory, { recursive: true })
  // A worker can write the runs directory, so it can swap either root for a link;
  // following one would copy files the worker itself is denied into artifacts.
  const linkedRoots = [scratch, artifacts].filter((root) =>
    lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink(),
  )
  if (linkedRoots.length > 0)
    throw new Error(
      `refusing to collect run artifacts through a symlinked root: ${linkedRoots.join(', ')}; inspect where it points, then remove the link`,
    )
  const { listed, namedLogical, failures } = collectArtifactCandidates({
    id,
    scratch,
    artifacts,
    namedPaths: namedPaths ?? [],
    worktreePath: worktree?.path ?? null,
    diff: changes?.diff,
  })
  if (failures.length > 0) throw new Error(failures.join('\n'))
  publishRetainedArtifacts({
    id,
    scratch,
    artifacts,
    runDirectory,
    listed,
    namedLogical,
    diff: changes?.diff,
  })
}
