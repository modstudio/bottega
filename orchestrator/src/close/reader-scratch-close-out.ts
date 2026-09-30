// concern: reader scratch close-out
/** Gathers reader scratch facts and archives approved scratch. Must not remove trees or settle claims. */
import { type Dirent, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gitResult } from '../git/git-environment.ts'
import { JOBS } from '../jobs/jobs.ts'
import { proveWorktreeReconstructible } from '../reclaim/reclaim.ts'
import { runArtifactsDir } from '../run/run-artifacts.ts'
import { worktreeDirty } from '../worktree/worktree-attribution.ts'
import { dryRunReleaseResult, reconstructibilityHold } from './absent-tree-close-out.ts'
import { readerScratchReleaseDecision } from './reader-scratch-release.ts'

type ReaderScratchCloseOutPlan =
  | { action: 'ordinary' }
  | { action: 'archive' }
  | { action: 'hold'; detail: string }

type ScratchCloseOutResult = {
  runId: number
  worktree: string
  outcome: 'held' | 'released' | 'absent'
  detail: string
}

/** Identify terminal dirty reader scratch without inspecting writing-job worktrees. */
function readerScratchCloseOutPlan(input: {
  job: string
  terminal: boolean
  treeAbsent: boolean
  treePath: string
}): ReaderScratchCloseOutPlan {
  if (!input.terminal) return { action: 'hold', detail: 'conversation is not terminal' }
  const definition = JOBS[input.job]
  const readOnlyJob = Boolean(definition?.needs.readsRepo) && !definition?.needs.writesRepo
  if (!readOnlyJob || input.treeAbsent) return { action: 'ordinary' }
  const decision = readerScratchReleaseDecision({
    readOnlyJob,
    terminal: input.terminal,
    cloneDirty: worktreeDirty(input.treePath).dirty,
    archiveSucceeded: null,
  })
  if (decision !== 'archive-then-release') return { action: 'ordinary' }
  const safety = proveWorktreeReconstructible(input.treePath, { allowDirty: true })
  return safety.ok ? { action: 'archive' } : { action: 'hold', detail: safety.action }
}

/** Resolve reader scratch and the ordinary reconstructibility/dry-run gates in one decision edge. */
export function prepareReaderScratchCloseOut(input: {
  runId: number
  job: string
  terminal: boolean
  treeAbsent: boolean
  treePath: string
  dryRun: boolean
}): { proceed: true; archive: boolean } | { proceed: false; result: ScratchCloseOutResult } {
  const plan = readerScratchCloseOutPlan(input)
  if (plan.action === 'hold')
    return {
      proceed: false,
      result: {
        runId: input.runId,
        worktree: input.treePath,
        outcome: 'held',
        detail: plan.detail,
      },
    }
  if (plan.action === 'ordinary') {
    const hold = reconstructibilityHold(input.runId, input.treePath, input.treeAbsent)
    if (hold) return { proceed: false, result: hold }
  }
  if (input.dryRun) {
    const result = dryRunReleaseResult(input.runId, input.treePath, input.treeAbsent)
    if (plan.action === 'archive')
      result.detail = 'would archive reader scratch and release its terminal clone'
    return { proceed: false, result }
  }
  return { proceed: true, archive: plan.action === 'archive' }
}

function archiveFailure(detail: string, terminal: boolean): { ok: false; detail: string } {
  const decision = readerScratchReleaseDecision({
    readOnlyJob: true,
    terminal,
    cloneDirty: true,
    archiveSucceeded: false,
  })
  return {
    ok: false,
    detail:
      decision === 'keep' ? detail : `archive failure produced unexpected ${decision} decision`,
  }
}

function inspectNestedRepository(
  treePath: string,
  repositoryPath: string,
  dirtyPaths: string[],
): string | null {
  if (!existsSync(join(repositoryPath, '.git'))) return null
  const nestedPath = relative(treePath, repositoryPath) || '.'
  const status = gitResult(
    ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
    repositoryPath,
  )
  if (!status.ok) return `could not inspect nested repository ${nestedPath}: ${status.stderr}`
  if (status.stdout.trim()) dirtyPaths.push(nestedPath)
  return null
}

function inspectNestedDirectory(
  treePath: string,
  directory: string,
  pending: string[],
  dirtyPaths: string[],
): string | null {
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    return `could not inspect ${relative(treePath, directory) || '.'}: ${String((error as Error).message ?? error)}`
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git') continue
    const child = join(directory, entry.name)
    const failure = inspectNestedRepository(treePath, child, dirtyPaths)
    if (failure) return failure
    pending.push(child)
  }
  return null
}

function inspectNestedRepositories(
  treePath: string,
): { ok: true; dirtyPaths: string[] } | { ok: false; detail: string } {
  const pending = [treePath]
  const dirtyPaths: string[] = []
  while (pending.length) {
    const directory = pending.pop()!
    const failure = inspectNestedDirectory(treePath, directory, pending, dirtyPaths)
    if (failure) return { ok: false, detail: failure }
  }
  return { ok: true, dirtyPaths }
}

/** Write tracked and untracked reader scratch as one patch without touching a ref. */
export function archiveReaderScratchForRelease(input: {
  runId: number
  treePath: string
  terminal: boolean
  planned: boolean
}): { ok: true; path: string | null } | { ok: false; detail: string } {
  if (!input.planned) return { ok: true, path: null }
  const nested = inspectNestedRepositories(input.treePath)
  if (!nested.ok)
    return archiveFailure(
      `scratch archive could not prove nested repositories clean: ${nested.detail}; preserve and clean nested repository changes, then retry close-out`,
      input.terminal,
    )
  if (nested.dirtyPaths.length)
    return archiveFailure(
      `scratch archive refused dirty nested repositories: ${nested.dirtyPaths.join(', ')}; preserve and clean their changes, then retry close-out`,
      input.terminal,
    )
  const intent = gitResult(['add', '-N', '--', '.'], input.treePath)
  if (!intent.ok || intent.stderr)
    return archiveFailure(
      `scratch archive failed at git add -N: ${intent.stderr || 'unknown error'}`,
      input.terminal,
    )
  const diff = gitResult(['diff', '--binary', 'HEAD', '--'], input.treePath)
  if (!diff.ok || diff.stderr)
    return archiveFailure(
      `scratch archive failed at git diff HEAD: ${diff.stderr || 'unknown error'}`,
      input.terminal,
    )

  const artifacts = runArtifactsDir(input.runId)
  const path = join(artifacts, 'reader-scratch.patch')
  try {
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(path, diff.stdout)
  } catch (error) {
    return archiveFailure(
      `scratch archive failed at write ${path}: ${String((error as Error).message ?? error)}`,
      input.terminal,
    )
  }
  const decision = readerScratchReleaseDecision({
    readOnlyJob: true,
    terminal: input.terminal,
    cloneDirty: true,
    archiveSucceeded: true,
  })
  return decision === 'release'
    ? { ok: true, path }
    : { ok: false, detail: 'reader scratch archive did not permit release' }
}

/** Add the durable archive address only when reader scratch was archived. */
export function readerScratchReleaseDetail(detail: string, path: string | null): string {
  return path ? `${detail}; reader scratch archived at ${path}` : detail
}
