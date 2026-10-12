// concern: review-command-cwd
/** Resolves the checkout selected by a review command. */
import { resolve } from 'node:path'
import { cwdMissing } from '../git/git-environment.ts'

export function resolveReviewCommandCwd(value?: string): string {
  const cwd = resolve(value ?? process.cwd())
  if (cwdMissing(cwd)) {
    throw new Error(`${cwd} does not exist; pass a live worktree (orch tree open <run> opens one)`)
  }
  return cwd
}
