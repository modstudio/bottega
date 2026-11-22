// concern: lifecycle-backed release checkout
/** Provisions, deploys from, and releases one detached checkout at an exact commit. */

import { randomUUID } from 'node:crypto'
import { createHookTree, removeHookTree } from '../hook-tree/tree.ts'
import type { Project } from '../project/projects.ts'
import { releaseProjectFromCheckout, type ReleaseResult } from './release-service.ts'

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
  const path = createHookTree({
    cwd: input.project.path,
    name: `release-${input.rung}-${randomUUID()}`,
    base: input.commit,
    detached: true,
  })
  const provisionMs = Date.now() - provisionStarted
  let result: ReleaseResult | undefined
  let failure: unknown
  const deployStarted = Date.now()
  try {
    result = releaseProjectFromCheckout(input.project.name, input.rung, path, input.commit)
  } catch (cause) {
    failure = cause
  }
  const deployMs = Date.now() - deployStarted
  const releaseStarted = Date.now()
  try {
    await removeHookTree(path)
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
