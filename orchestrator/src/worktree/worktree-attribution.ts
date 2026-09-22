// concern: worktree-attribution
/**
 * Knows worktree markers, ownership, dirty state, orphan safety, and extraction
 * to artifacts. Must not know routing, contracts, transports, run state, or CLI adapters.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { resolveRunsDirectory } from '../database/database-location.ts'
import { db } from '../database/db.ts'
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
  conversationRunIds: readonly number[]
  directoryName: string
  repoRoot: string
  branchTemplate?: string
  checkout: boolean | 'unknown'
  marker:
    | { state: 'absent' }
    | { state: 'unreadable' }
    | { state: 'present'; runId: number | null; repoRoot: string | null }
}

/** Read the run id carried by a current or legacy worktree directory name. */
export function worktreeNameRunId(name: string, branchTemplate?: string): number | null {
  const conventional = name.match(/^orch-(\d+)$/)
  if (conventional) return Number(conventional[1])
  if (!branchTemplate?.includes('{id}')) return null

  let idGroup = 0
  const pattern = basename(branchTemplate)
    .split(/(\{id\}|\{key\})/g)
    .map((part) => {
      if (part === '{id}') {
        idGroup++
        return idGroup === 1 ? '(\\d+)' : '\\d+'
      }
      if (part === '{key}') return '[^/]+'
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  const match = name.match(new RegExp(`^${pattern}$`))
  return match?.[1] ? Number(match[1]) : null
}

/** Decide whether this conversation owns a checkout without reading process state or storage. */
export function treeOwnership(input: TreeOwnershipInput): TreeOwnership {
  if (input.checkout === 'unknown') return 'unknown'
  if (!input.checkout) return 'unknown'
  if (input.marker.state === 'unreadable') return 'unknown'

  const conversation = new Set(input.conversationRunIds)
  if (input.marker.state === 'present') {
    if (input.marker.runId === null || input.marker.repoRoot === null) return 'unknown'
    const markerRoot = resolve(input.marker.repoRoot).replace(/\/$/, '')
    const expectedRoot = resolve(input.repoRoot).replace(/\/$/, '')
    return conversation.has(input.marker.runId) && markerRoot === expectedRoot
      ? 'owned'
      : 'attached'
  }

  const namedRun = worktreeNameRunId(input.directoryName, input.branchTemplate)
  return namedRun !== null && conversation.has(namedRun) ? 'owned' : 'attached'
}

/** Gather marker and checkout facts at the storage edge, then apply the ownership decision. */
export function inspectTreeOwnership(
  path: string,
  repoRoot: string,
  conversationRunIds: readonly number[],
  branchTemplate?: string,
): TreeOwnership {
  if (!existsSync(path)) {
    return treeOwnership({
      conversationRunIds,
      directoryName: basename(path),
      repoRoot,
      branchTemplate,
      checkout: 'unknown',
      marker: { state: 'absent' },
    })
  }
  const checkout = gitOk(['rev-parse', '--is-inside-work-tree'], path)
  const markerPath = join(path, ORCH_RUN_MARKER)
  let marker: TreeOwnershipInput['marker'] = { state: 'absent' }
  if (existsSync(markerPath)) {
    try {
      const [runIdLine, markerRoot] = readFileSync(markerPath, 'utf8').split('\n')
      marker = {
        state: 'present',
        runId: /^\d+$/.test(runIdLine ?? '') ? Number(runIdLine) : null,
        repoRoot: markerRoot?.trim() || null,
      }
    } catch {
      marker = { state: 'unreadable' }
    }
  }
  return treeOwnership({
    conversationRunIds,
    directoryName: basename(path),
    repoRoot,
    branchTemplate,
    checkout: checkout === null ? 'unknown' : checkout === 'true',
    marker,
  })
}

/** Read lifecycle provenance from current markers; legacy markers have none. */
export function markedWorktreeSource(path: string): Worktree['source'] | undefined {
  try {
    const line = readFileSync(join(path, ORCH_RUN_MARKER), 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('source: '))
    const source = line?.slice('source: '.length)
    return source === 'recipe' ||
      source === 'git' ||
      source === 'clone' ||
      source === 'readonly_recipe'
      ? source
      : undefined
  } catch {
    return undefined
  }
}

/** Recognise current markers and the naming schemes used before markers existed. */
export function isOrchWorktree(path: string, branchTemplate?: string): boolean {
  if (existsSync(join(path, ORCH_RUN_MARKER))) return true
  return worktreeNameRunId(basename(path), branchTemplate) !== null
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
      const markerRoot = readFileSync(join(path, ORCH_RUN_MARKER), 'utf8').split('\n')[1]?.trim()
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

/** Recognise only the conventional unmarked reader clone location left by an interrupted create. */
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

function runRowExists(id: number): boolean {
  try {
    return db().query('SELECT 1 AS present FROM run WHERE id=?').get(id) != null
  } catch {
    return false
  }
}

/** Filesystem-safe encoding of an absolute path for the orphan extraction dir. */
function sanitiseOrphanExtractionPath(path: string): string {
  const real = existsSync(path) ? realpathOrSpelled(path) : resolve(path)
  return real.replace(/^[\\/]+/, '').replace(/[^A-Za-z0-9._-]+/g, '--')
}

function extractionDest(
  tree: string,
  runId: number | null,
  runsDir = resolveRunsDirectory(process.env),
): string {
  if (runId !== null && runRowExists(runId)) return join(runsDir, String(runId), 'artifacts')
  return join(runsDir, 'orphans', sanitiseOrphanExtractionPath(tree))
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
  const recordedId = runId !== null && runRowExists(runId) ? runId : null
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
