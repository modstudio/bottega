// concern: lifecycle-backed release checkout
/** Provisions, deploys from, and releases one checkout at an exact commit. */

import { randomUUID } from 'node:crypto'
import {
  createHookTree,
  type HookTreeRemovalResult,
  removeHookTreeResult,
} from '../hook-tree/tree.ts'
import {
  type CheckoutReleaseTarget,
  type ReleaseResult,
  releaseProjectFromCheckout,
  resolveCheckoutReleaseTarget,
} from './release-service.ts'

export type ReleaseAtCommitReport = {
  result: ReleaseResult
  provisionMs: number
  deployMs: number
  releaseMs: number
  residue?: string
}

export type ReleaseAtCommitDependencies = {
  resolve(project: string, rung: string, commit: string): CheckoutReleaseTarget
  create(target: CheckoutReleaseTarget, name: string, commit: string): string
  deploy(target: CheckoutReleaseTarget, path: string, commit: string): ReleaseResult
  remove(path: string): Promise<HookTreeRemovalResult>
  id(): string
  now(): number
}

const releaseAtCommitDependencies: ReleaseAtCommitDependencies = {
  resolve: resolveCheckoutReleaseTarget,
  create(target, name, commit) {
    return createHookTree({ cwd: target.project.path, name, base: commit })
  },
  deploy: releaseProjectFromCheckout,
  remove: (path) => removeHookTreeResult(path, 'operator-removal'),
  id: randomUUID,
  now: Date.now,
}

function removalResidue(result: HookTreeRemovalResult): string | undefined {
  if (result.outcome === 'kept') return result.reason
  if (result.outcome === 'failed') return result.detail
  return undefined
}

export async function releaseAtCommit(input: {
  project: string
  rung: string
  commit: string
  dependencies?: ReleaseAtCommitDependencies
}): Promise<ReleaseAtCommitReport> {
  const dependencies = input.dependencies ?? releaseAtCommitDependencies
  const target = dependencies.resolve(input.project, input.rung, input.commit)
  const provisionStarted = dependencies.now()
  const treeName = `release-${input.rung}-${dependencies.id()}`
  const path = dependencies.create(target, treeName, input.commit)
  const provisionMs = dependencies.now() - provisionStarted
  let result: ReleaseResult | undefined
  let failure: unknown
  const deployStarted = dependencies.now()
  try {
    result = dependencies.deploy(target, path, input.commit)
  } catch (cause) {
    failure = cause
  }
  const deployMs = dependencies.now() - deployStarted
  const releaseStarted = dependencies.now()
  let residue: string | undefined
  try {
    residue = removalResidue(await dependencies.remove(path))
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
