// concern: focused-test-paths
/** Filesystem adapter for focused-test path existence and canonical confinement facts. */

import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  decideFocusedTestPathFacts,
  type FocusedTestPathFact,
  normalizeAffectedTestPaths,
} from './focused-test-decision.ts'

function focusedTestPathFacts(
  entries: readonly string[],
  normalizedPaths: readonly string[],
  worktree: string,
): FocusedTestPathFact[] {
  const resolvedRoot = realpathSync(worktree)
  return normalizedPaths.map((normalized, index): FocusedTestPathFact => {
    let resolvedCandidate: string | null = null
    let exists = false
    try {
      resolvedCandidate = realpathSync(resolve(resolvedRoot, normalized))
      statSync(resolvedCandidate)
      exists = true
    } catch {
      // The pure decision turns the missing filesystem fact into the public refusal.
    }
    return { entry: entries[index]!, normalized, resolvedRoot, resolvedCandidate, exists }
  })
}

/**
 * The paths one call will run, which may include a selector's selection. The count bound is decided
 * with the selection itself, so every path here is checked for existence and confinement only.
 */
export function validateAffectedTestPaths(paths: readonly string[], worktree: string): string[] {
  return decideFocusedTestPathFacts(
    focusedTestPathFacts(paths, normalizeAffectedTestPaths(paths), worktree),
  )
}
