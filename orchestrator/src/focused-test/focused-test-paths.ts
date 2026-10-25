// concern: focused-test-paths
/** Filesystem adapter for focused-test path existence and canonical confinement facts. */

import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { decideFocusedTestPathFacts, type FocusedTestPathFact } from './focused-test-decision.ts'

function focusedTestPathFacts(entries: readonly string[], worktree: string): FocusedTestPathFact[] {
  const resolvedRoot = realpathSync(worktree)
  return entries.map((path): FocusedTestPathFact => {
    let resolvedCandidate: string | null = null
    let exists = false
    try {
      resolvedCandidate = realpathSync(resolve(resolvedRoot, path))
      statSync(resolvedCandidate)
      exists = true
    } catch {
      // The pure decision turns the missing filesystem fact into the public refusal.
    }
    return { path, resolvedRoot, resolvedCandidate, exists }
  })
}

/**
 * Refuses a focused test run whose paths do not exist or resolve outside the run worktree, throwing
 * the decision's message. Paths arrive normalized — a worker's at its call edge, a selector's where
 * its output was parsed — so this checks existence and canonical confinement only. The count bound
 * on what one worker call may ask for is decided with the selection itself
 * (`decideFocusedTestSelection`), never here, because a project's selector may legitimately find
 * more paths than a worker may name in one call.
 */
export function validateFocusedTestRunPaths(paths: readonly string[], worktree: string): void {
  decideFocusedTestPathFacts(focusedTestPathFacts(paths, worktree))
}
