// concern: review-command-cwd
/** Resolves the checkout selected by a review command. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export function resolveReviewCommandCwd(value?: string): string {
  const cwd = resolve(value ?? process.cwd())
  if (!existsSync(cwd)) {
    throw new Error(`${cwd} does not exist; pass a live worktree (orch tree open <run> opens one)`)
  }
  return cwd
}
