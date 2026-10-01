// concern: reader clone close-out
/** Proves reader clones disposable or archives them whole. Must not remove claims. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { gitResult } from '../git/git-environment.ts'
import { JOBS } from '../jobs/jobs.ts'
import { RUNS_DIR, runArtifactsDir } from '../run/run-artifacts.ts'
import { dryRunReleaseResult, reconstructibilityHold } from './absent-tree-close-out.ts'
import { readerCloneReleaseDecision } from './reader-scratch-release.ts'

type ReaderCloneCloseOutPlan =
  | { action: 'ordinary' | 'remove' | 'archive' }
  | { action: 'hold'; detail: string }
type ScratchCloseOutResult = {
  runId: number
  worktree: string
  outcome: 'held' | 'released' | 'absent'
  detail: string
}
const SEARCH_LIMIT = 10_000

function repositoryStorageAbsent(treePath: string): boolean {
  if (existsSync(join(treePath, '.git', 'modules'))) return false
  const pending = [treePath]
  let inspected = 0
  try {
    while (pending.length) {
      const directory = pending.pop()!
      const entries = readdirSync(directory, { withFileTypes: true })
      inspected += entries.length
      if (inspected > SEARCH_LIMIT) return false
      const relativeDirectory = relative(treePath, directory)
      if (
        relativeDirectory &&
        existsSync(join(directory, 'HEAD')) &&
        existsSync(join(directory, 'objects')) &&
        existsSync(join(directory, 'refs'))
      )
        return false
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === '.git') {
          if (directory !== treePath) return false
          continue
        }
        pending.push(join(directory, entry.name))
      }
      if (relativeDirectory && existsSync(join(directory, '.git'))) return false
    }
  } catch {
    return false
  }
  return true
}

function noUniqueReachableCommit(treePath: string, repoRoot: string, baseCommit: string): boolean {
  const sourceRefs = gitResult(['for-each-ref', '--format=%(objectname)'], repoRoot)
  if (!sourceRefs.ok) return false
  const exclusions = sourceRefs.stdout
    .split('\n')
    .filter(Boolean)
    .map((oid) => `^${oid}`)
  const result = gitResult(['rev-list', '--all', `^${baseCommit}`, ...exclusions], treePath)
  return result.ok && result.stdout.trim() === ''
}

export function readerCloneDisposableFacts(input: {
  treePath: string
  repoRoot: string
  baseCommit: string
}): { clean: boolean; atBase: boolean; noUniqueCommits: boolean; noNestedStorage: boolean } {
  const status = gitResult(
    ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
    input.treePath,
  )
  const head = gitResult(['rev-parse', 'HEAD'], input.treePath)
  return {
    clean: status.ok && status.stdout === '',
    atBase: Boolean(input.baseCommit) && head.ok && head.stdout.trim() === input.baseCommit,
    noUniqueCommits:
      Boolean(input.baseCommit) &&
      noUniqueReachableCommit(input.treePath, input.repoRoot, input.baseCommit),
    noNestedStorage: repositoryStorageAbsent(input.treePath),
  }
}

function readerScratchCloseOutPlan(input: {
  job: string
  terminal: boolean
  treeAbsent: boolean
  treePath: string
  repoRoot: string
  baseCommit: string
}): ReaderCloneCloseOutPlan {
  const definition = JOBS[input.job]
  const readOnlyJob = Boolean(definition?.needs.readsRepo) && !definition?.needs.writesRepo
  if (!input.terminal) return { action: 'hold', detail: 'conversation is not terminal' }
  if (!readOnlyJob || input.treeAbsent) return { action: 'ordinary' }
  const facts = readerCloneDisposableFacts({
    treePath: input.treePath,
    repoRoot: input.repoRoot,
    baseCommit: input.baseCommit,
  })
  const provablyDisposable = Boolean(
    facts.clean && facts.atBase && facts.noUniqueCommits && facts.noNestedStorage,
  )
  const decision = readerCloneReleaseDecision({
    readOnlyJob,
    terminal: input.terminal,
    treeAbsent: input.treeAbsent,
    provablyDisposable,
    archiveSucceeded: null,
  })
  if (decision === 'keep') return { action: 'hold', detail: 'conversation is not terminal' }
  if (decision === 'archive-then-release') return { action: 'archive' }
  if (decision === 'remove') return { action: 'remove' }
  return { action: 'ordinary' }
}

export function prepareReaderScratchCloseOut(input: {
  runId: number
  job: string
  terminal: boolean
  treeAbsent: boolean
  treePath: string
  repoRoot: string
  baseCommit: string
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
      result.detail = 'would archive whole reader clone and release its claims'
    return { proceed: false, result }
  }
  return { proceed: true, archive: plan.action === 'archive' }
}

function archiveDestination(runId: number, now = new Date()): string {
  const timestamp = now.toISOString().replaceAll(':', '').replaceAll('.', '')
  return join(dirname(RUNS_DIR), 'archive', 'reader-clones', `${runId}-${timestamp}`)
}

function writeConveniencePatch(runId: number, treePath: string): void {
  try {
    const intent = gitResult(['add', '-N', '--', '.'], treePath)
    if (!intent.ok) return
    const diff = gitResult(['diff', '--binary', 'HEAD', '--'], treePath)
    if (!diff.ok) return
    const artifacts = runArtifactsDir(runId)
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(artifacts, 'reader-scratch.patch'), diff.stdout)
  } catch {
    // The patch is only a convenience summary; the whole clone is the record.
  }
}

export function archiveReaderScratchForRelease(input: {
  runId: number
  treePath: string
  terminal: boolean
  planned: boolean
}): { ok: true; path: string | null } | { ok: false; detail: string } {
  if (!input.planned) return { ok: true, path: null }
  writeConveniencePatch(input.runId, input.treePath)
  const destination = archiveDestination(input.runId)
  const artifacts = runArtifactsDir(input.runId)
  const pointer = join(artifacts, 'reader-clone-archive.json')
  try {
    mkdirSync(join(destination, '..'), { recursive: true })
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(
      pointer,
      `${JSON.stringify({ path: destination, archivedAt: new Date().toISOString() }, null, 2)}\n`,
    )
    try {
      renameSync(input.treePath, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      cpSync(input.treePath, destination, {
        recursive: true,
        errorOnExist: true,
        preserveTimestamps: true,
      })
      try {
        rmSync(input.treePath, { recursive: true })
      } catch (removeError) {
        return {
          ok: false,
          detail:
            `whole reader clone was copied to ${destination}, but source removal failed: ` +
            `${String((removeError as Error).message ?? removeError)}`,
        }
      }
    }
    const archivedAt = new Date()
    try {
      utimesSync(destination, archivedAt, archivedAt)
    } catch {
      // Naming records archive time even when the filesystem refuses a metadata touch.
    }
  } catch (error) {
    if (!existsSync(destination) && existsSync(pointer)) unlinkSync(pointer)
    return {
      ok: false,
      detail: `whole reader clone archive failed: ${String((error as Error).message ?? error)}`,
    }
  }
  const decision = readerCloneReleaseDecision({
    readOnlyJob: true,
    terminal: input.terminal,
    treeAbsent: false,
    provablyDisposable: false,
    archiveSucceeded: true,
  })
  return decision === 'release'
    ? { ok: true, path: destination }
    : { ok: false, detail: `reader clone archive did not permit release (${decision})` }
}

export function readerScratchReleaseDetail(detail: string, path: string | null): string {
  return path ? `${detail}; whole reader clone archived at ${path}` : detail
}
