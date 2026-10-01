// concern: orphan worktree Docker resource policy and teardown

import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  removeDockerResource,
  type UnattributableDockerResource,
  type UnattributedComposeDockerResource,
} from './docker-resources.ts'

export type OrphanWorktreeDockerResource =
  | UnattributableDockerResource
  | UnattributedComposeDockerResource

export type OrphanWorktreeDockerFacts = {
  workingDir: string
  projectPath: string
  directoryExists: boolean | null
  gitWorktreePaths: readonly string[] | null
  mainCheckoutPaths: readonly string[]
  registeredMainCheckout: boolean
}

function pathsEqual(left: string, right: string): boolean {
  return resolve(left) === resolve(right)
}

/** Decide only from established facts whether an unattributed resource is an orphan. */
export function isOrphanWorktreeDockerResource(facts: OrphanWorktreeDockerFacts): boolean {
  const workingDir = resolve(facts.workingDir)
  const worktreesRoot = resolve(facts.projectPath, '.claude/worktrees')
  const withinRoot = relative(worktreesRoot, workingDir)
  if (
    !withinRoot ||
    withinRoot === '..' ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinRoot)
  )
    return false
  if (
    facts.registeredMainCheckout ||
    facts.mainCheckoutPaths.some((path) => pathsEqual(path, workingDir))
  )
    return false
  if (facts.directoryExists !== false || facts.gitWorktreePaths === null) return false
  return !facts.gitWorktreePaths.some((path) => pathsEqual(path, workingDir))
}

export type OrphanDockerTeardown = {
  complete: boolean
  errors: string[]
  removed: OrphanWorktreeDockerResource[]
  skipped: boolean
}

/** Remove one proven-orphan Compose stack in dependency order. */
export function teardownOrphanWorktreeDockerResources(
  resources: OrphanWorktreeDockerResource[],
  mainCheckoutPaths: readonly string[],
  canRemove: () => boolean,
): OrphanDockerTeardown {
  const errors: string[] = []
  const removed: OrphanWorktreeDockerResource[] = []
  let skipped = false
  const ordered = ['container', 'network', 'volume'] as const
  for (const resource of ordered.flatMap((kind) =>
    resources.filter((item) => item.kind === kind),
  )) {
    // Repeat the main-checkout and absent-directory guards at the mutation boundary.
    if (
      resource.mainCheckout ||
      (resource.workingDir !== null &&
        mainCheckoutPaths.some((path) => pathsEqual(path, resource.workingDir)))
    ) {
      skipped = true
      errors.push(`refused to remove main-checkout Docker resource ${resource.name}`)
      continue
    }
    if (!canRemove()) {
      skipped = true
      break
    }
    const detail = removeDockerResource(resource)
    if (detail) {
      errors.push(detail)
      continue
    }
    removed.push(resource)
  }
  return { complete: errors.length === 0 && !skipped, errors, removed, skipped }
}
