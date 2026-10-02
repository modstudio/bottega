// concern: run-base-resolution
/** Resolves a run base and adds both durable and readable identities to a resume refusal. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { resolveBase } from '../git/git-environment.ts'

export function resolveRunBase(
  input: { cwd: string; base: string; resumeParent?: number; launchBase?: string },
  database: Database = db(),
  resolve: (cwd: string, base: string) => string = resolveBase,
): void {
  try {
    resolve(input.cwd, input.base)
  } catch (error) {
    const root = input.resumeParent
      ? (database
          .query('SELECT launch_base,base_commit FROM run WHERE id=?')
          .get(input.resumeParent) as {
          launch_base: string | null
          base_commit: string | null
        } | null)
      : null
    const recordedCommit = root?.base_commit ?? (input.launchBase ? input.base : null)
    const launchBranch = root?.launch_base ?? input.launchBase
    if (!recordedCommit) throw error
    throw new Error(
      `cannot resolve recorded base commit ${recordedCommit} ` +
        `for launch branch ${launchBranch ?? '(none)'}: ${(error as Error).message}`,
    )
  }
}
