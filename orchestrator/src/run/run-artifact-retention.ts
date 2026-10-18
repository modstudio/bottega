// concern: run-artifact-retention
/** Pure policy for selecting the bounded files a finished run retains. */

export const RUN_ARTIFACT_FILE_CAP_BYTES = 5 * 1024 * 1024
export const RUN_ARTIFACT_TOTAL_CAP_BYTES = 25 * 1024 * 1024
export const OUTSIDE_DEPTH_AGGREGATE_FILE_LIMIT = 10
export const RUN_ARTIFACT_BUILD_OUTPUT_DIRECTORIES = [
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.turbo',
  '.cache',
] as const

const DEPENDENCY_DIRECTORIES = new Set(['node_modules', 'vendor', '.venv', 'target'])
const BUILD_OUTPUT_DIRECTORIES = new Set<string>(RUN_ARTIFACT_BUILD_OUTPUT_DIRECTORIES)

export type RunArtifactListingEntry = {
  path: string
  kind: 'file' | 'directory' | 'symlink'
  size: number
  linkText?: string
}

export type RunArtifactDropReason =
  | 'copy'
  | 'dependency'
  | 'build output'
  | 'over the per-file cap'
  | 'over the total cap'
  | 'outside retention depth'
  | 'symlink'

export type RunArtifactDrop = {
  path: string
  size: number
  reason: RunArtifactDropReason
  fileCount?: number
  linkText?: string
}

export type RunArtifactRetentionPlan = {
  kept: string[]
  dropped: RunArtifactDrop[]
  keptBytes: number
  droppedBytes: number
}

const parts = (path: string) => path.split('/').filter(Boolean)
const atOrBelow = (path: string, directory: string) =>
  directory === '.' || path === directory || path.startsWith(`${directory}/`)

function excludedDirectories(
  entries: RunArtifactListingEntry[],
): Map<string, RunArtifactDropReason> {
  const candidates = new Map<string, RunArtifactDropReason>()
  for (const entry of entries) {
    if (entry.kind !== 'directory') continue
    const segments = parts(entry.path)
    const name = segments.at(-1)
    if (name === '.git') candidates.set(segments.slice(0, -1).join('/') || '.', 'copy')
    else if (name && DEPENDENCY_DIRECTORIES.has(name)) candidates.set(entry.path, 'dependency')
    else if (name && BUILD_OUTPUT_DIRECTORIES.has(name)) candidates.set(entry.path, 'build output')
  }
  const selected = new Map<string, RunArtifactDropReason>()
  for (const [path, reason] of [...candidates].sort(
    ([a], [b]) => parts(a).length - parts(b).length,
  )) {
    if (![...selected].some(([parent]) => atOrBelow(path, parent))) selected.set(path, reason)
  }
  return selected
}

function aggregateDrop(
  path: string,
  reason: RunArtifactDropReason,
  entries: RunArtifactListingEntry[],
): RunArtifactDrop {
  const descendants = entries.filter(
    (entry) => entry.kind !== 'directory' && atOrBelow(entry.path, path),
  )
  return {
    path,
    size: descendants.reduce((sum, entry) => sum + entry.size, 0),
    reason,
    fileCount: descendants.length,
  }
}

export function decideRunArtifactRetention(
  listing: RunArtifactListingEntry[],
  namedPaths: string[],
): RunArtifactRetentionPlan {
  const entries = [...listing].sort((a, b) => a.path.localeCompare(b.path))
  const excluded = excludedDirectories(entries)
  const dropped: RunArtifactDrop[] = [...excluded].map(([path, reason]) =>
    aggregateDrop(path, reason, entries),
  )
  const excludedPaths = new Set(
    entries.filter((entry) => [...excluded.keys()].some((path) => atOrBelow(entry.path, path))),
  )
  const symlinks = entries.filter((entry) => entry.kind === 'symlink' && !excludedPaths.has(entry))
  dropped.push(
    ...symlinks.map((entry) => ({
      path: entry.path,
      size: entry.size,
      reason: 'symlink' as const,
      linkText: entry.linkText ?? '',
    })),
  )

  const files = entries.filter((entry) => entry.kind === 'file' && !excludedPaths.has(entry))
  const namedRank = (path: string) => namedPaths.findIndex((named) => atOrBelow(path, named))
  const outside = files.filter(
    (entry) =>
      entry.path !== 'worktree.diff' && namedRank(entry.path) < 0 && parts(entry.path).length > 2,
  )
  const outsideGroups = new Map<string, RunArtifactListingEntry[]>()
  for (const entry of outside) {
    const directory = parts(entry.path).slice(0, 2).join('/')
    const group = outsideGroups.get(directory) ?? []
    group.push(entry)
    outsideGroups.set(directory, group)
  }
  const outsideAggregated = new Set<RunArtifactListingEntry>()
  for (const [directory, group] of outsideGroups) {
    if (group.length > OUTSIDE_DEPTH_AGGREGATE_FILE_LIMIT) {
      dropped.push({
        path: directory,
        size: group.reduce((sum, entry) => sum + entry.size, 0),
        reason: 'outside retention depth',
        fileCount: group.length,
      })
      for (const entry of group) outsideAggregated.add(entry)
    }
  }
  for (const entry of outside) {
    if (!outsideAggregated.has(entry)) {
      dropped.push({ path: entry.path, size: entry.size, reason: 'outside retention depth' })
    }
  }

  const eligible = files.filter((entry) => !outside.includes(entry))
  eligible.sort((a, b) => {
    if (a.path === 'worktree.diff') return -1
    if (b.path === 'worktree.diff') return 1
    const aRank = namedRank(a.path)
    const bRank = namedRank(b.path)
    if (aRank >= 0 || bRank >= 0) {
      if (aRank < 0) return 1
      if (bRank < 0) return -1
      if (aRank !== bRank) return aRank - bRank
    }
    return a.path.localeCompare(b.path)
  })

  const kept: string[] = []
  let keptBytes = 0
  for (const entry of eligible) {
    const named = namedRank(entry.path) >= 0
    if (entry.path !== 'worktree.diff' && !named && entry.size > RUN_ARTIFACT_FILE_CAP_BYTES) {
      dropped.push({ path: entry.path, size: entry.size, reason: 'over the per-file cap' })
      continue
    }
    if (entry.path !== 'worktree.diff' && keptBytes + entry.size > RUN_ARTIFACT_TOTAL_CAP_BYTES) {
      dropped.push({ path: entry.path, size: entry.size, reason: 'over the total cap' })
      continue
    }
    kept.push(entry.path)
    keptBytes += entry.size
  }
  dropped.sort((a, b) => a.path.localeCompare(b.path))
  return {
    kept,
    dropped,
    keptBytes,
    droppedBytes: dropped.reduce((sum, entry) => sum + entry.size, 0),
  }
}
