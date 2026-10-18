// concern: worktree-attribution
/**
 * Knows worktree markers, ownership, dirty state, orphan safety, and extraction
 * to artifacts. Must not know routing, contracts, transports, run state, or CLI adapters.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { resolveRunsDirectory } from '../database/database-location.ts'
import { db } from '../database/db.ts'
import type { FilesystemIdentityPlan, FilesystemIdentityRun } from '../filesystem-identity-plan.ts'
import { realpathOrSpelled } from '../git/checkout-identity.ts'
import { borrowedCheckoutOf, gitOk, gitResult } from '../git/git-environment.ts'
import type { Worktree } from './worktree-types.ts'

export type OrphanSafety = {
  removable: boolean
  branch: string
  detail: string
}

export const ORCH_RUN_MARKER = '.orch-run'

export type TreeOwnership = 'owned' | 'attached' | 'unknown'

export type TreeOwnershipInput = {
  conversationRunIds: readonly string[]
  repoRoot: string
  checkout: boolean | 'unknown'
  marker:
    | { state: 'absent' }
    | { state: 'unreadable' }
    | { state: 'present'; runRecordId: string | null; repoRoot: string | null }
}

/** Read the UUID carried by a worktree ownership marker. Names are display labels only. */
export type WorktreeMarkerRead =
  | {
      state: 'absent' | 'unreadable'
      owner: null
      runRecordId: null
      repoRoot: null
      source: undefined
    }
  | {
      state: 'present'
      owner: string
      runRecordId: string | null
      repoRoot: string | null
      source: Worktree['source'] | undefined
    }

export function readWorktreeMarker(path: string): WorktreeMarkerRead {
  const marker = join(path, ORCH_RUN_MARKER)
  if (!existsSync(marker))
    return { state: 'absent', owner: null, runRecordId: null, repoRoot: null, source: undefined }
  try {
    const [owner = '', root = '', ...rest] = readFileSync(marker, 'utf8').split('\n')
    const candidate = rest.find((line) => line.startsWith('source: '))?.slice(8)
    const source =
      candidate === 'recipe' ||
      candidate === 'git' ||
      candidate === 'clone' ||
      candidate === 'readonly_recipe'
        ? candidate
        : undefined
    return {
      state: 'present',
      owner: owner.trim(),
      runRecordId: hasRecordIdShape(owner.trim()) ? owner.trim().toLowerCase() : null,
      repoRoot: root.trim() || null,
      source,
    }
  } catch {
    return {
      state: 'unreadable',
      owner: null,
      runRecordId: null,
      repoRoot: null,
      source: undefined,
    }
  }
}

export type WorktreeMarkerMigrationCandidate = {
  worktree: string
  marker: WorktreeMarkerRead
  text: string
}

/** Pure marker decision: numeric owners map only when repository provenance agrees. */
export function planWorktreeMarkerMigration(
  candidates: readonly WorktreeMarkerMigrationCandidate[],
  runs: ReadonlyMap<string, FilesystemIdentityRun>,
): FilesystemIdentityPlan<string> {
  const plan: FilesystemIdentityPlan<string> = { mapped: [], collisions: [], unmapped: [] }
  for (const candidate of candidates) {
    if (candidate.marker.state !== 'present' || candidate.marker.runRecordId) continue
    const number = candidate.marker.owner
    if (!/^[1-9]\d*$/.test(number)) continue
    const source = join(candidate.worktree, ORCH_RUN_MARKER)
    const run = runs.get(number)
    if (!run) {
      plan.unmapped.push({ source, number, reason: `owner ${number} maps to no run` })
      continue
    }
    if (
      !candidate.marker.repoRoot ||
      !run.projectPath ||
      resolve(candidate.marker.repoRoot) !== resolve(run.projectPath)
    ) {
      plan.unmapped.push({
        source,
        number,
        reason: `repository root does not match run ${number}'s project`,
      })
      continue
    }
    plan.mapped.push({
      source,
      destination: source,
      run,
      payload: candidate.text,
    })
  }
  return plan
}

export function discoverWorktreeMarkerMigration(
  worktrees: Iterable<string>,
  runs: ReadonlyMap<string, FilesystemIdentityRun>,
): FilesystemIdentityPlan<string> {
  const candidates: WorktreeMarkerMigrationCandidate[] = []
  for (const worktree of worktrees) {
    const markerPath = join(worktree, ORCH_RUN_MARKER)
    if (!existsSync(markerPath)) continue
    candidates.push({
      worktree,
      marker: readWorktreeMarker(worktree),
      text: readFileSync(markerPath, 'utf8'),
    })
  }
  return planWorktreeMarkerMigration(candidates, runs)
}

export function applyWorktreeMarkerMigration(plan: FilesystemIdentityPlan<string>): number {
  for (const move of plan.mapped) {
    const [, ...rest] = move.payload.split('\n')
    const temporary = join(dirname(move.source), `.${basename(move.source)}.uuid-migration`)
    writeFileSync(temporary, [move.run.recordId, ...rest].join('\n'))
    renameSync(temporary, move.source)
  }
  return plan.mapped.length
}

export function worktreeNameRunId(path: string): string | null {
  return readWorktreeMarker(path).runRecordId
}

/** Decide whether this conversation owns a checkout without reading process state or storage. */
export function treeOwnership(input: TreeOwnershipInput): TreeOwnership {
  if (input.checkout === 'unknown') return 'unknown'
  if (!input.checkout) return 'unknown'
  if (input.marker.state === 'unreadable') return 'unknown'

  const conversation = new Set(input.conversationRunIds)
  if (input.marker.state === 'present') {
    if (input.marker.runRecordId === null || input.marker.repoRoot === null) return 'unknown'
    const markerRoot = resolve(input.marker.repoRoot).replace(/\/$/, '')
    const expectedRoot = resolve(input.repoRoot).replace(/\/$/, '')
    return conversation.has(input.marker.runRecordId) && markerRoot === expectedRoot
      ? 'owned'
      : 'attached'
  }

  return 'attached'
}

/** Gather marker and checkout facts at the storage edge, then apply the ownership decision. */
export function inspectTreeOwnership(
  path: string,
  repoRoot: string,
  conversationRunIds: readonly number[],
): TreeOwnership {
  if (!existsSync(path)) {
    return treeOwnership({
      conversationRunIds: conversationRunIds.flatMap((id) => {
        const row = db()
          .query<{ record_id: string }, [number]>('SELECT record_id FROM run WHERE id=?')
          .get(id)
        return row ? [row.record_id] : []
      }),
      repoRoot,
      checkout: 'unknown',
      marker: { state: 'absent' },
    })
  }
  const checkout = gitOk(['rev-parse', '--is-inside-work-tree'], path)
  const read = readWorktreeMarker(path)
  const marker: TreeOwnershipInput['marker'] =
    read.state === 'present'
      ? { state: 'present', runRecordId: read.runRecordId, repoRoot: read.repoRoot }
      : { state: read.state }
  return treeOwnership({
    conversationRunIds: conversationRunIds.flatMap((id) => {
      const row = db()
        .query<{ record_id: string }, [number]>('SELECT record_id FROM run WHERE id=?')
        .get(id)
      return row ? [row.record_id] : []
    }),
    repoRoot,
    checkout: checkout === null ? 'unknown' : checkout === 'true',
    marker,
  })
}

/** Read lifecycle provenance from current markers; legacy markers have none. */
export function markedWorktreeSource(path: string): Worktree['source'] | undefined {
  return readWorktreeMarker(path).source
}

/** Recognize current markers and the naming schemes used before markers existed. */
export function isOrchWorktree(path: string): boolean {
  if (existsSync(join(path, ORCH_RUN_MARKER))) return true
  return false
}

/**
 * Prove the directory is a registered git worktree of this repository.
 *
 * Dirty trees are recoverable: extractWorktree copies uncommitted and untracked
 * work into the run record before removal. This predicate no longer inspects
 * that work. It still refuses a path git does not list as a worktree, which is
 * not a worktree at all.
 */
export function orphanSafety(path: string, repoRoot: string, _trunk: string): OrphanSafety {
  const listed = gitOk(['worktree', 'list', '--porcelain'], repoRoot)
  const actual = existsSync(path) ? realpathSync(path) : path
  const registered = listed
    ?.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .some((candidate) => existsSync(candidate) && realpathSync(candidate) === actual)
  let markedBorrowedCheckout = false
  if (!registered && existsSync(join(path, ORCH_RUN_MARKER))) {
    try {
      const markerRoot = readWorktreeMarker(path).repoRoot
      const borrowed = borrowedCheckoutOf(path)
      markedBorrowedCheckout =
        Boolean(markerRoot && borrowed) &&
        realpathSync(markerRoot!) === realpathSync(repoRoot) &&
        realpathSync(borrowed!) === realpathSync(repoRoot)
    } catch {
      markedBorrowedCheckout = false
    }
  }
  let unmarkedBorrowedReader = false
  if (!registered && !existsSync(join(path, ORCH_RUN_MARKER))) {
    try {
      const borrowed = borrowedCheckoutOf(path)
      unmarkedBorrowedReader = isUnmarkedBorrowedReaderClone({
        path: realpathSync(path),
        repoRoot: realpathSync(repoRoot),
        borrowedSource: borrowed ? realpathSync(borrowed) : null,
      })
    } catch {
      unmarkedBorrowedReader = false
    }
  }
  if (!registered && !markedBorrowedCheckout && !unmarkedBorrowedReader) {
    return {
      removable: false,
      branch: '',
      detail: 'not a registered git worktree or marked borrowed checkout',
    }
  }

  const branch = gitOk(['symbolic-ref', '--quiet', '--short', 'HEAD'], path) ?? ''
  return { removable: true, branch, detail: 'committed work is retained by its branch' }
}

/** Recognize only the conventional unmarked reader clone location left by an interrupted create. */
export function isUnmarkedBorrowedReaderClone(input: {
  path: string
  repoRoot: string
  borrowedSource: string | null
}): boolean {
  return (
    /^orch-\d+$/.test(basename(input.path)) &&
    dirname(input.path) === join(input.repoRoot, '.claude', 'worktrees') &&
    input.borrowedSource === input.repoRoot
  )
}

/** Classify git-status exit, stdout and stderr without running git. */
export function classifyWorktreeDirty(
  exitCode: number,
  stdout: string,
  stderr: string,
): { dirty: boolean; detail: string } {
  const err = stderr.trim()
  if (exitCode !== 0 || err) {
    const firstLine = err.split(/\r?\n/, 1)[0] ?? ''
    return {
      dirty: true,
      detail: `could not inspect uncommitted or untracked work: ${firstLine}`,
    }
  }
  return stdout.trim()
    ? { dirty: true, detail: 'has uncommitted or untracked changes' }
    : { dirty: false, detail: 'all work is committed' }
}

/** The one retention fact a checkout can hold that its branch cannot. */
export function worktreeDirty(path: string): { dirty: boolean; detail: string } {
  const status = gitResult(['status', '--porcelain', '--untracked-files=all'], path)
  return classifyWorktreeDirty(status.ok ? 0 : 1, status.stdout, status.stderr)
}

export type WorktreeExtraction = {
  runId: number | null
  tree: string
  headSha: string | null
  branch: string | null
  trackedBytes: number
  untrackedCount: number
  extractedAt: string
  ok: boolean
}

function runRecordId(id: number): string | null {
  try {
    return (
      db().query<{ record_id: string }, [number]>('SELECT record_id FROM run WHERE id=?').get(id)
        ?.record_id ?? null
    )
  } catch {
    return null
  }
}

/** Filesystem-safe encoding of an absolute path for the orphan extraction dir. */
function sanitizeOrphanExtractionPath(path: string): string {
  const real = existsSync(path) ? realpathOrSpelled(path) : resolve(path)
  return real.replace(/^[\\/]+/, '').replace(/[^A-Za-z0-9._-]+/g, '--')
}

function extractionDest(
  tree: string,
  runId: number | null,
  runsDir = resolveRunsDirectory(process.env),
): string {
  if (runId !== null) {
    const recordId = runRecordId(runId)
    if (recordId) return join(runsDir, recordId, 'artifacts')
  }
  return join(runsDir, 'orphans', sanitizeOrphanExtractionPath(tree))
}

function writeExtractionJson(dest: string, record: WorktreeExtraction): void {
  writeFileSync(join(dest, 'extraction.json'), `${JSON.stringify(record)}\n`)
}

/**
 * Copy a tree's uncommitted and untracked work into the run record.
 *
 * A clean tree writes only extraction.json with ok:true. A failed step refuses
 * and names the step; the tree is left in place.
 */
export function extractWorktree(
  tree: string,
  runId: number | null,
  runsDir = resolveRunsDirectory(process.env),
): { ok: true; dest: string; record: WorktreeExtraction } | { ok: false; detail: string } {
  const recordedId = runId !== null && runRecordId(runId) ? runId : null
  const dest = extractionDest(tree, runId, runsDir)
  const record: WorktreeExtraction = {
    runId: recordedId,
    tree,
    headSha: null,
    branch: null,
    trackedBytes: 0,
    untrackedCount: 0,
    extractedAt: new Date().toISOString(),
    ok: false,
  }
  const failed = (step: string, why: string): { ok: false; detail: string } => ({
    ok: false,
    detail: `extraction failed at ${step}: ${why || 'unknown error'}`,
  })
  try {
    mkdirSync(dest, { recursive: true })
  } catch (error) {
    return failed(`create ${dest}`, String(error))
  }

  const head = gitResult(['rev-parse', 'HEAD'], tree)
  if (!head.ok) return failed('git rev-parse HEAD', head.stderr)
  record.headSha = head.stdout.trim()
  const named = gitResult(['symbolic-ref', '--quiet', '--short', 'HEAD'], tree)
  record.branch = named.ok ? named.stdout.trim() : ''

  const status = gitResult(['status', '--porcelain', '--untracked-files=all'], tree)
  if (!status.ok) return failed('git status', status.stderr)
  if (!status.stdout.trim()) {
    record.ok = true
    try {
      writeExtractionJson(dest, record)
    } catch (error) {
      return failed('write extraction.json', String(error))
    }
    return { ok: true, dest, record }
  }

  const diff = gitResult(['diff', 'HEAD'], tree)
  if (!diff.ok) return failed('git diff HEAD', diff.stderr)
  if (diff.stdout.length) {
    try {
      writeFileSync(join(dest, 'uncommitted.patch'), diff.stdout)
    } catch (error) {
      return failed('write uncommitted.patch', String(error))
    }
    record.trackedBytes = Buffer.byteLength(diff.stdout)
  }

  const others = gitResult(['ls-files', '--others', '--exclude-standard', '-z'], tree)
  if (!others.ok) return failed('git ls-files --others --exclude-standard', others.stderr)
  const files = others.stdout.split('\0').filter(Boolean)
  record.untrackedCount = files.length
  if (files.length) {
    try {
      for (const rel of files) {
        const to = join(dest, 'untracked', rel)
        mkdirSync(dirname(to), { recursive: true })
        cpSync(join(tree, rel), to)
      }
    } catch (error) {
      return failed('copy untracked files', String(error))
    }
  }

  record.ok = true
  try {
    writeExtractionJson(dest, record)
  } catch (error) {
    return failed('write extraction.json', String(error))
  }
  return { ok: true, dest, record }
}
