// concern: lifecycle-backed release checkout
/** Provisions, deploys from, and releases one detached checkout at an exact commit. */

import { randomUUID } from 'node:crypto'
import { type Project, resolvedWorktreeTool } from '../project/projects.ts'
import { createWithTool } from '../worktree/worktree-create.ts'
import { removeFor } from '../worktree/worktree-remove.ts'
import { type ReleaseResult, releaseProjectFromCheckout } from './release-service.ts'

export type ReleaseAtCommitReport = {
  result: ReleaseResult
  provisionMs: number
  deployMs: number
  releaseMs: number
}

export async function releaseAtCommit(input: {
  project: Project
  rung: string
  commit: string
}): Promise<ReleaseAtCommitReport> {
  const provisionStarted = Date.now()
  const treeId = `release-${input.rung}-${randomUUID()}`
  const tool = resolvedWorktreeTool(input.project)
  if (!tool) throw new Error(`project ${input.project.name} has no sanctioned worktree lifecycle`)
  const worktree = createWithTool(
    tool,
    input.project.path,
    treeId,
    undefined,
    undefined,
    input.commit,
    undefined,
    true,
  )
  const provisionMs = Date.now() - provisionStarted
  let result: ReleaseResult | undefined
  let failure: unknown
  const deployStarted = Date.now()
  try {
    result = releaseProjectFromCheckout(input.project.name, input.rung, worktree.path, input.commit)
  } catch (cause) {
    failure = cause
  }
  const deployMs = Date.now() - deployStarted
  const releaseStarted = Date.now()
  try {
    const removed = removeFor(worktree, input.project.path, false, false, treeId)
    if (!removed.removed) throw new Error(removed.detail)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    if (failure) {
      const deployDetail = failure instanceof Error ? failure.message : String(failure)
      throw new Error(`${deployDetail}; release checkout teardown also failed: ${detail}`)
    }
    throw new Error(`release checkout teardown failed: ${detail}`)
  }
  const releaseMs = Date.now() - releaseStarted
  if (failure) throw failure
  return { result: result!, provisionMs, deployMs, releaseMs }
}
