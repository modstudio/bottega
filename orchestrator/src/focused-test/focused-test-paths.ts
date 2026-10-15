// concern: focused-test-paths
/** Filesystem adapter for focused-test path existence and canonical confinement facts. */

import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  decideFocusedTestPathFacts,
  type FocusedTestPathFact,
  normalizeFocusedTestPaths,
} from './focused-test-decision.ts'

export function validateFocusedTestPaths(paths: readonly string[], worktree: string): string[] {
  const normalizedPaths = normalizeFocusedTestPaths(paths)
  const resolvedRoot = realpathSync(worktree)
  const facts = normalizedPaths.map((normalized, index): FocusedTestPathFact => {
    let resolvedCandidate: string | null = null
    let exists = false
    try {
      resolvedCandidate = realpathSync(resolve(resolvedRoot, normalized))
      statSync(resolvedCandidate)
      exists = true
    } catch {
      // The pure decision turns the missing filesystem fact into the public refusal.
    }
    return { entry: paths[index]!, normalized, resolvedRoot, resolvedCandidate, exists }
  })
  return decideFocusedTestPathFacts(facts)
}
