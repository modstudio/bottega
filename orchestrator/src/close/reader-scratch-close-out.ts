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

const NESTED_REPOSITORY_SEARCH_LIMIT = 10_000

function nestedRepositoryHold(paths: string[]): ReaderScratchCloseOutPlan {
  return {
    action: 'hold',
    detail:
      `reader clone contains nested repositories: ${paths.join(', ')}; ` +
      'inspect and remove them by hand before retrying close-out',
  }
}

function initializedSubmodulePaths(
  treePath: string,
): { ok: true; paths: string[] } | { ok: false; detail: string } {
  const status = gitResult(['submodule', 'status', '--recursive'], treePath)
  if (!status.ok)
    return {
      ok: false,
      detail: `could not inspect initialized submodules: ${status.stderr || 'unknown error'}`,
    }
  const paths = status.stdout
    .split('\n')
    .filter((line) => line && line[0] !== '-')
    .map((line) =>
      line
        .slice(1)
        .trimStart()
        .replace(/^[0-9a-f]+\s+/, '')
        .replace(/\s+\(.*\)$/, ''),
    )
    .filter(Boolean)
  return { ok: true, paths }
}

function nestedDirectoryEntries(
  treePath: string,
  directory: string,
  entries: Dirent[],
  pending: string[],
  paths: string[],
): void {
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git') continue
    const child = join(directory, entry.name)
    if (existsSync(join(child, '.git'))) paths.push(relative(treePath, child))
    else pending.push(child)
  }
}

function readNestedDirectory(
  treePath: string,
  directory: string,
): { ok: true; entries: Dirent[] } | { ok: false; detail: string } {
  try {
    return { ok: true, entries: readdirSync(directory, { withFileTypes: true }) }
  } catch (error) {
    return {
      ok: false,
      detail: `could not inspect ${relative(treePath, directory) || '.'}: ${String((error as Error).message ?? error)}`,
    }
  }
}

function nestedGitEntryPaths(
  treePath: string,
): { ok: true; paths: string[] } | { ok: false; detail: string } {
  const pending = [treePath]
  const paths: string[] = []
  let inspected = 0
  while (pending.length) {
    const directory = pending.pop()!
    const read = readNestedDirectory(treePath, directory)
    if (!read.ok) return read
    inspected += read.entries.length
    if (inspected > NESTED_REPOSITORY_SEARCH_LIMIT)
      return {
        ok: false,
        detail: `nested repository search exceeded ${NESTED_REPOSITORY_SEARCH_LIMIT} entries`,
      }
    nestedDirectoryEntries(treePath, directory, read.entries, pending, paths)
  }
  return { ok: true, paths }
}

function nestedRepositoryPaths(
  treePath: string,
): { ok: true; paths: string[] } | { ok: false; detail: string } {
  const submodules = initializedSubmodulePaths(treePath)
  if (!submodules.ok) return submodules
  const entries = nestedGitEntryPaths(treePath)
  if (!entries.ok) return entries
  return { ok: true, paths: [...new Set([...submodules.paths, ...entries.paths])].sort() }
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
  const nested = nestedRepositoryPaths(input.treePath)
  if (!nested.ok)
    return {
      action: 'hold',
      detail: `${nested.detail}; clone and nested contents retained for manual inspection`,
    }
  if (nested.paths.length) return nestedRepositoryHold(nested.paths)
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

/** Write tracked and untracked reader scratch as one patch without touching a ref. */
export function archiveReaderScratchForRelease(input: {
  runId: number
  treePath: string
  terminal: boolean
  planned: boolean
}): { ok: true; path: string | null } | { ok: false; detail: string } {
  if (!input.planned) return { ok: true, path: null }
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
