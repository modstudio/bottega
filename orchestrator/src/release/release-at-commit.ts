// concern: lifecycle-backed release checkout
/** Provisions, deploys from, and releases one detached checkout at an exact commit. */

import { randomUUID } from 'node:crypto'
import { type Project, resolvedWorktreeTool } from '../project/projects.ts'
import {
  createWithTool,
  createWorktree,
  withoutRunWorktreeAttribution,
} from '../worktree/worktree-create.ts'
import { removeFor } from '../worktree/worktree-remove.ts'
import {
  checkoutReleaseProject,
  type ReleaseResult,
  releaseProjectFromCheckout,
} from './release-service.ts'

export type ReleaseAtCommitReport = {
  result: ReleaseResult
  provisionMs: number
  deployMs: number
  releaseMs: number
  residue?: string
}

export type ReleaseAtCommitDependencies = {
  project(project: string, rung: string): Project
  create(project: Project, treeId: string, commit: string): ReturnType<typeof createWorktree>
  deploy(project: string, rung: string, path: string, commit: string): ReleaseResult
  remove(
    worktree: ReturnType<typeof createWorktree>,
    project: Project,
    treeId: string,
  ): { removed: boolean; detail: string }
  id(): string
  now(): number
}

const releaseAtCommitDependencies: ReleaseAtCommitDependencies = {
  project: checkoutReleaseProject,
  create(project, treeId, commit) {
    const tool = resolvedWorktreeTool(project)
    return tool
      ? createWithTool(
          tool,
          project.path,
          treeId,
          undefined,
          undefined,
          commit,
          withoutRunWorktreeAttribution,
          true,
        )
      : createWorktree(project.path, treeId, commit, withoutRunWorktreeAttribution, true)
  },
  deploy: releaseProjectFromCheckout,
  remove: (worktree, project, treeId) => removeFor(worktree, project.path, false, false, treeId),
  id: randomUUID,
  now: Date.now,
}

export async function releaseAtCommit(input: {
  project: string
  rung: string
  commit: string
  dependencies?: ReleaseAtCommitDependencies
}): Promise<ReleaseAtCommitReport> {
  const dependencies = input.dependencies ?? releaseAtCommitDependencies
  const project = dependencies.project(input.project, input.rung)
  const provisionStarted = dependencies.now()
  const treeId = `release-${input.rung}-${dependencies.id()}`
  const worktree = dependencies.create(project, treeId, input.commit)
  const provisionMs = dependencies.now() - provisionStarted
  let result: ReleaseResult | undefined
  let failure: unknown
  const deployStarted = dependencies.now()
  try {
    result = dependencies.deploy(input.project, input.rung, worktree.path, input.commit)
  } catch (cause) {
    failure = cause
  }
  const deployMs = dependencies.now() - deployStarted
  const releaseStarted = dependencies.now()
  let residue: string | undefined
  try {
    const removed = dependencies.remove(worktree, project, treeId)
    if (!removed.removed) residue = removed.detail
  } catch (cause) {
    residue = cause instanceof Error ? cause.message : String(cause)
  }
  const releaseMs = dependencies.now() - releaseStarted
  if (failure) {
    if (!residue) throw failure
    const detail = failure instanceof Error ? failure.message : String(failure)
    throw new Error(`${detail}; release checkout residue: ${residue}`)
  }
  return { result: result!, provisionMs, deployMs, releaseMs, ...(residue ? { residue } : {}) }
}
