// concern: reader clone commit observation
/** Observes clone commits against source refs. Must not know run state or cleanup policy. */
import { gitResult } from '../git/git-environment.ts'

export function readerCloneSourceRefExclusions(repoRoot: string): string[] | null {
  const sourceRefs = gitResult(['for-each-ref', '--format=%(objectname)'], repoRoot)
  if (!sourceRefs.ok) return null
  return sourceRefs.stdout
    .split('\n')
    .filter(Boolean)
    .map((oid) => `^${oid}`)
}

function uniqueReachableCommitCount(
  treePath: string,
  exclusions: readonly string[],
): number | null {
  const result = gitResult(['rev-list', '--count', '--all', ...exclusions], treePath)
  if (!result.ok) return null
  const count = Number(result.stdout.trim())
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

export function readerCloneHasNoUniqueCommits(
  treePath: string,
  exclusions: readonly string[],
  baseCommit?: string,
): boolean {
  return (
    uniqueReachableCommitCount(
      treePath,
      baseCommit ? [`^${baseCommit}`, ...exclusions] : exclusions,
    ) === 0
  )
}

/** Count commits the clone can reach that no ref in the source checkout can reach. */
export function readerCloneUniqueCommitCount(treePath: string, repoRoot: string): number | null {
  const exclusions = readerCloneSourceRefExclusions(repoRoot)
  return exclusions === null ? null : uniqueReachableCommitCount(treePath, exclusions)
}
