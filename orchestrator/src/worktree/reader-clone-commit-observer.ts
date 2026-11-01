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

function uniqueReachableCommits(treePath: string, exclusions: readonly string[]): string[] | null {
  const result = gitResult(['rev-list', '--all', ...exclusions], treePath)
  if (!result.ok) return null
  return result.stdout.split('\n').filter(Boolean)
}

function commitsAbsentFromSourceObjectStore(
  commits: readonly string[],
  repoRoot: string,
): number | null {
  if (commits.length === 0) return 0
  const result = gitResult(['cat-file', '--batch-check'], repoRoot, {
    input: Buffer.from(`${commits.map((commit) => `${commit}^{commit}`).join('\n')}\n`),
  })
  if (!result.ok) return null
  const observations = result.stdout.trimEnd().split('\n')
  if (observations.length !== commits.length) return null
  let missing = 0
  for (const observation of observations) {
    if (observation.endsWith(' missing')) missing += 1
    else if (!/^[0-9a-f]+ commit \d+$/.test(observation)) return null
  }
  return missing
}

function uniqueCommitCount(
  treePath: string,
  repoRoot: string,
  exclusions: readonly string[],
): number | null {
  const commits = uniqueReachableCommits(treePath, exclusions)
  return commits === null ? null : commitsAbsentFromSourceObjectStore(commits, repoRoot)
}

export function readerCloneHasNoUniqueCommits(
  treePath: string,
  repoRoot: string,
  exclusions: readonly string[],
  baseCommit?: string,
): boolean {
  return (
    uniqueCommitCount(
      treePath,
      repoRoot,
      baseCommit ? [`^${baseCommit}`, ...exclusions] : exclusions,
    ) === 0
  )
}

/** Count clone-reachable commits that no source ref reaches and its object store lacks. */
export function readerCloneUniqueCommitCount(treePath: string, repoRoot: string): number | null {
  const exclusions = readerCloneSourceRefExclusions(repoRoot)
  return exclusions === null ? null : uniqueCommitCount(treePath, repoRoot, exclusions)
}
