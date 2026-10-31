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
import { nulPathListArgs, splitNulPaths } from '../../../shared/git-path-list.ts'
import { gitResult } from '../git/git-environment.ts'
import { isReadOnlyRepositoryJob } from '../jobs/jobs.ts'
import { RUNS_DIR, runArtifactsDir } from '../run/run-artifacts.ts'
import { extractWorktree } from '../worktree/worktree-attribution.ts'
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
export type SharedReaderArchiveIdentity = { sharerRunIds: string[] }
type ReaderCloneArchivePlan = {
  facts: ReaderCloneDisposableFacts
  shared: SharedReaderArchiveIdentity | null
  baseCommit: string
  sourceRefExclusions: string[] | null
}
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
  const index = gitResult(nulPathListArgs(['ls-files', '--stage']), treePath)
  if (!index.ok || splitNulPaths(index.stdout).some((line) => line.startsWith('160000 ')))
    return false
  const tracked = gitResult(nulPathListArgs(['ls-files']), treePath)
  if (!tracked.ok) return false
  const trackedDirectories = new Set<string>()
  for (const path of splitNulPaths(tracked.stdout))
    for (let directory = dirname(path); directory !== '.'; directory = dirname(directory))
      trackedDirectories.add(directory)
  if ([...trackedDirectories].some((directory) => existsSync(join(treePath, directory, '.git'))))
    return false
  const untracked = gitResult(
    nulPathListArgs(['ls-files', '--others', '--exclude-standard', '--directory']),
    treePath,
  )
  if (!untracked.ok) return false
  for (const path of splitNulPaths(untracked.stdout)) {
    if (!path.endsWith('/')) continue
    const directory = join(treePath, path)
    if (existsSync(join(directory, '.git')) || looksLikeBareRepository(directory)) return false
  }
  return true
}

function sourceRefExclusions(repoRoot: string): string[] | null {
  const sourceRefs = gitResult(['for-each-ref', '--format=%(objectname)'], repoRoot)
  if (!sourceRefs.ok) return null
  return sourceRefs.stdout
    .split('\n')
    .filter(Boolean)
    .map((oid) => `^${oid}`)
}

function noUniqueReachableCommit(
  treePath: string,
  baseCommit: string,
  exclusions: readonly string[],
): boolean {
  const result = gitResult(['rev-list', '--all', `^${baseCommit}`, ...exclusions], treePath)
  return result.ok && result.stdout.trim() === ''
}

function readerCloneDisposableFacts(input: {
  treePath: string
  repoRoot: string
  baseCommit: string
}): { facts: ReaderCloneDisposableFacts; sourceRefExclusions: string[] | null } {
  const status = gitResult(
    ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
    input.treePath,
  )
  const head = gitResult(['rev-parse', 'HEAD'], input.treePath)
  const exclusions = sourceRefExclusions(input.repoRoot)
  return {
    facts: {
      clean: status.ok && status.stdout === '',
      atBase: Boolean(input.baseCommit) && head.ok && head.stdout.trim() === input.baseCommit,
      noUniqueCommits:
        Boolean(input.baseCommit) &&
        exclusions !== null &&
        noUniqueReachableCommit(input.treePath, input.baseCommit, exclusions),
      noNestedStorage: repositoryStorageAbsent(input.treePath),
    },
    sourceRefExclusions: exclusions,
  }
}

function readerScratchCloseOutPlan(input: {
  job: string
  terminal: boolean
  treeAbsent: boolean
  treePath: string
  repoRoot: string
  baseCommit: string
  shared: SharedReaderArchiveIdentity | null
}): ReaderCloneCloseOutPlan {
  const readOnlyJob = isReadOnlyRepositoryJob(input.job)
  if (!input.terminal) return { action: 'hold', detail: 'conversation is not terminal' }
  if (!readOnlyJob || input.treeAbsent) return { action: 'ordinary' }
  const disposable = readerCloneDisposableFacts({
    treePath: input.treePath,
    repoRoot: input.repoRoot,
    baseCommit: input.baseCommit,
  })
  const facts = disposable.facts
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
  if (decision === 'archive-then-release')
    return {
      action: 'archive',
      plan: {
        facts,
        shared: input.shared,
        baseCommit: input.baseCommit,
        sourceRefExclusions: disposable.sourceRefExclusions,
      },
    }
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
  shared?: SharedReaderArchiveIdentity | null
}):
  | { proceed: true; archive: ReaderCloneArchivePlan | null }
  | { proceed: false; result: ScratchCloseOutResult } {
  const plan = readerScratchCloseOutPlan({ ...input, shared: input.shared ?? null })
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
  sharedPath?: string
  headBundle?: string
  head?: string
}): void {
  writeFileSync(
    input.pointer,
    `${JSON.stringify(
      {
        path: input.destination,
        archivedAt: new Date().toISOString(),
        ...input.planned.facts,
        ignoredRemoved: input.ignoredRemoved,
        ...(input.headBundle ? { headBundle: input.headBundle } : {}),
        ...(input.head ? { head: input.head } : {}),
        ...(input.planned.shared
          ? {
              sharedPath: input.sharedPath,
              sharerRunIds: input.planned.shared.sharerRunIds,
            }
          : {}),
      },
      null,
      2,
    )}\n`,
  )
}

function removeIgnoredArchivePaths(destination: string): string | null {
  const ignored = gitResult(
    nulPathListArgs(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']),
    destination,
  )
  if (!ignored.ok) return `git ignored-path listing failed: ${ignored.stderr}`
  try {
    for (const path of splitNulPaths(ignored.stdout)) {
      if (path === '.git' || path.startsWith('.git/'))
        throw new Error(`git listed repository storage as ignored: ${path}`)
      rmSync(join(destination, path), { recursive: true, force: true })
    }
  } catch (error) {
    return String((error as Error).message ?? error)
  }
  return null
}

/** Extract changed paths and preserve unique refs before shared-tree removal. */
function archiveSharedReaderScratch(input: {
  runId: string
  treePath: string
  planned: ReaderCloneArchivePlan
}): ({ ok: true } & ReaderCloneArchiveRelease) | { ok: false; detail: string } {
  const sourceRefExclusions = input.planned.sourceRefExclusions
  if (!input.planned.facts.noUniqueCommits && !sourceRefExclusions)
    return { ok: false, detail: 'shared reader source refs could not be archived safely' }
  const archiveExclusions = sourceRefExclusions ?? []
  const extracted = extractWorktree(input.treePath, input.runId)
  if (!extracted.ok) return { ok: false, detail: extracted.detail }
  let headBundle: string | undefined
  if (!input.planned.facts.noUniqueCommits) {
    headBundle = join(extracted.dest, 'head.bundle')
    const bundled = gitResult(
      [
        'bundle',
        'create',
        headBundle,
        '--all',
        `^${input.planned.baseCommit}`,
        ...archiveExclusions,
      ],
      input.treePath,
    )
    if (!bundled.ok)
      return {
        ok: false,
        detail: `shared reader committed-work archive failed: ${bundled.stderr}`,
      }
  }
  const head =
    !input.planned.facts.atBase && input.planned.facts.noUniqueCommits
      ? gitResult(['rev-parse', 'HEAD'], input.treePath)
      : null
  if (head && !head.ok)
    return { ok: false, detail: `shared reader HEAD archive failed: ${head.stderr}` }
  const pointer = join(runArtifactsDir(input.runId), 'reader-clone-archive.json')
  writeArchivePointer({
    pointer,
    destination: extracted.dest,
    planned: input.planned,
    ignoredRemoved: true,
    sharedPath: input.treePath,
    headBundle,
    head: head?.stdout.trim(),
  })
  return {
    ok: true,
    path: extracted.dest,
    ignoredRemovalFailure: null,
  }
}

function archiveReaderScratchForRelease(input: {
  runId: string
  treePath: string
  terminal: boolean
  planned: ReaderCloneArchivePlan | null
}): ({ ok: true } & ReaderCloneArchiveRelease) | { ok: false; detail: string } {
  if (!input.planned) return { ok: true, path: null, ignoredRemovalFailure: null }
  if (input.planned.shared)
    return archiveSharedReaderScratch({
      runId: input.runId,
      treePath: input.treePath,
      planned: input.planned,
    })
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
