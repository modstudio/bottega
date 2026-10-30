// concern: reader clone close-out
/** Proves reader clones disposable or archives them whole. Must not remove claims. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { gitResult } from '../git/git-environment.ts'
import { isReadOnlyRepositoryJob } from '../jobs/jobs.ts'
import { RUNS_DIR, runArtifactsDir } from '../run/run-artifacts.ts'
import { dryRunReleaseResult, reconstructibilityHold } from './absent-tree-close-out.ts'
import {
  formatReaderCloneArchiveStamp,
  readerCloneReleaseDecision,
} from './reader-scratch-release.ts'

type ReaderCloneDisposableFacts = {
  clean: boolean
  atBase: boolean
  noUniqueCommits: boolean
  noNestedStorage: boolean
}
type ReaderCloneArchivePlan = { facts: ReaderCloneDisposableFacts }
type ReaderCloneCloseOutPlan =
  | { action: 'ordinary' | 'remove' }
  | { action: 'archive'; plan: ReaderCloneArchivePlan }
  | { action: 'hold'; detail: string }
type ScratchCloseOutResult = {
  runId: string
  worktree: string
  outcome: 'held' | 'released' | 'absent'
  detail: string
}
type ReaderCloneArchiveRelease = {
  path: string | null
  ignoredRemovalFailure: string | null
}

/** Extraction evidence belongs to the turn whose tree is being removed. */
export function extractionRunId(row: { record_id: string }): string {
  return row.record_id
}

function looksLikeBareRepository(directory: string): boolean {
  return Boolean(
    existsSync(join(directory, 'HEAD')) &&
      existsSync(join(directory, 'objects')) &&
      existsSync(join(directory, 'refs')),
  )
}

function repositoryStorageAbsent(treePath: string): boolean {
  if (existsSync(join(treePath, '.git', 'modules'))) return false
  const index = gitResult(['ls-files', '--stage'], treePath)
  if (!index.ok || index.stdout.split('\n').some((line) => line.startsWith('160000 '))) return false
  const tracked = gitResult(['ls-files', '-z'], treePath)
  if (!tracked.ok) return false
  const trackedDirectories = new Set(
    tracked.stdout
      .split('\0')
      .filter(Boolean)
      .map((path) => dirname(path))
      .filter((directory) => directory !== '.'),
  )
  if ([...trackedDirectories].some((directory) => existsSync(join(treePath, directory, '.git'))))
    return false
  const untracked = gitResult(
    ['ls-files', '--others', '--exclude-standard', '--directory', '-z'],
    treePath,
  )
  if (!untracked.ok) return false
  for (const path of untracked.stdout.split('\0').filter(Boolean)) {
    if (!path.endsWith('/')) continue
    const directory = join(treePath, path)
    if (existsSync(join(directory, '.git')) || looksLikeBareRepository(directory)) return false
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

function readerCloneDisposableFacts(input: {
  treePath: string
  repoRoot: string
  baseCommit: string
}): ReaderCloneDisposableFacts {
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
  const readOnlyJob = isReadOnlyRepositoryJob(input.job)
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
  if (decision === 'archive-then-release') return { action: 'archive', plan: { facts } }
  if (decision === 'remove') return { action: 'remove' }
  return { action: 'ordinary' }
}

export function prepareReaderScratchCloseOut(input: {
  runId: string
  job: string
  terminal: boolean
  treeAbsent: boolean
  treePath: string
  repoRoot: string
  baseCommit: string
  dryRun: boolean
}):
  | { proceed: true; archive: ReaderCloneArchivePlan | null }
  | { proceed: false; result: ScratchCloseOutResult } {
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
  return { proceed: true, archive: plan.action === 'archive' ? plan.plan : null }
}

function readerScratchDryRunResult(
  runId: string,
  treePath: string,
  treeAbsent: boolean,
  archive: boolean,
): ScratchCloseOutResult {
  const result = dryRunReleaseResult(runId, treePath, treeAbsent)
  if (archive) result.detail = 'would archive whole reader clone and release its claims'
  return result
}

function archiveDestination(runId: string, now = new Date()): string {
  return join(
    dirname(RUNS_DIR),
    'archive',
    'reader-clones',
    `${runId}-${formatReaderCloneArchiveStamp(now)}`,
  )
}

function writeConveniencePatch(runId: string, treePath: string): void {
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

function writeArchivePointer(input: {
  pointer: string
  destination: string
  planned: ReaderCloneArchivePlan
  ignoredRemoved: boolean
}): void {
  writeFileSync(
    input.pointer,
    `${JSON.stringify(
      {
        path: input.destination,
        archivedAt: new Date().toISOString(),
        ...input.planned.facts,
        ignoredRemoved: input.ignoredRemoved,
      },
      null,
      2,
    )}\n`,
  )
}

function removeIgnoredArchivePaths(destination: string): string | null {
  const ignored = gitResult(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    destination,
  )
  if (!ignored.ok) return `git ignored-path listing failed: ${ignored.stderr}`
  try {
    for (const path of ignored.stdout.split('\0').filter(Boolean)) {
      if (path === '.git' || path.startsWith('.git/'))
        throw new Error(`git listed repository storage as ignored: ${path}`)
      rmSync(join(destination, path), { recursive: true, force: true })
    }
  } catch (error) {
    return String((error as Error).message ?? error)
  }
  return null
}

function archiveReaderScratchForRelease(input: {
  runId: string
  treePath: string
  terminal: boolean
  planned: ReaderCloneArchivePlan | null
}): ({ ok: true } & ReaderCloneArchiveRelease) | { ok: false; detail: string } {
  if (!input.planned) return { ok: true, path: null, ignoredRemovalFailure: null }
  writeConveniencePatch(input.runId, input.treePath)
  const destination = archiveDestination(input.runId)
  const artifacts = runArtifactsDir(input.runId)
  const pointer = join(artifacts, 'reader-clone-archive.json')
  let ignoredRemovalFailure: string | null = null
  try {
    mkdirSync(join(destination, '..'), { recursive: true })
    mkdirSync(artifacts, { recursive: true })
    writeArchivePointer({
      pointer,
      destination,
      planned: input.planned,
      ignoredRemoved: false,
    })
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
    ignoredRemovalFailure = removeIgnoredArchivePaths(destination)
    writeArchivePointer({
      pointer,
      destination,
      planned: input.planned,
      ignoredRemoved: ignoredRemovalFailure === null,
    })
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
    ? {
        ok: true,
        path: destination,
        ignoredRemovalFailure,
      }
    : { ok: false, detail: `reader clone archive did not permit release (${decision})` }
}

export function prepareReaderScratchRelease(input: {
  runId: string
  treePath: string
  terminal: boolean
  planned: ReaderCloneArchivePlan | null
  dryRun: boolean
  treeAbsent: boolean
}):
  | ({ proceed: true } & ReaderCloneArchiveRelease)
  | { proceed: false; result: ScratchCloseOutResult } {
  if (input.dryRun)
    return {
      proceed: false,
      result: readerScratchDryRunResult(
        input.runId,
        input.treePath,
        input.treeAbsent,
        input.planned !== null,
      ),
    }
  const archive = archiveReaderScratchForRelease(input)
  if (archive.ok)
    return {
      proceed: true,
      path: archive.path,
      ignoredRemovalFailure: archive.ignoredRemovalFailure,
    }
  return {
    proceed: false,
    result: {
      runId: input.runId,
      worktree: input.treePath,
      outcome: 'held',
      detail: `${archive.detail}; clone and claim retained`,
    },
  }
}

export function readerScratchReleaseDetail(
  detail: string,
  release: ReaderCloneArchiveRelease,
): string {
  const archived = release.path
    ? `${detail}; whole reader clone archived at ${release.path}`
    : detail
  return release.ignoredRemovalFailure
    ? `${archived}; ignored paths not removed: ${release.ignoredRemovalFailure}`
    : archived
}
