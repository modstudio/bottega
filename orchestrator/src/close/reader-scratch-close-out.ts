// concern: reader scratch close-out
/** Gathers reader scratch facts and archives approved scratch. Must not remove trees or settle claims. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitResult } from '../git/git-environment.ts'
import { JOBS } from '../jobs/jobs.ts'
import { proveWorktreeReconstructible } from '../reclaim/reclaim.ts'
import { runArtifactsDir } from '../run/run-artifacts.ts'
import { worktreeDirty } from '../worktree/worktree-attribution.ts'
import { readerScratchReleaseDecision } from './reader-scratch-release.ts'

export type ReaderScratchCloseOutPlan =
  | { action: 'ordinary' }
  | { action: 'archive' }
  | { action: 'hold'; detail: string }

/** Identify terminal dirty reader scratch without inspecting writing-job worktrees. */
export function readerScratchCloseOutPlan(input: {
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
}): { ok: true; path: string } | { ok: false; detail: string } {
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
