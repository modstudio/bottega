// concern: run-artifact-retention
/** Pure policy for selecting the bounded files a finished run retains. */

import {
  OUTSIDE_DEPTH_AGGREGATE_FILE_LIMIT,
  RUN_ARTIFACT_BUILD_OUTPUT_DIRECTORIES,
  RUN_ARTIFACT_FILE_CAP_BYTES,
  RUN_ARTIFACT_TOTAL_CAP_BYTES,
} from './run-artifact-limits.ts'

const DEPENDENCY_DIRECTORIES = new Set(['node_modules', 'vendor', '.venv', 'target'])
const BUILD_OUTPUT_DIRECTORIES = new Set<string>(RUN_ARTIFACT_BUILD_OUTPUT_DIRECTORIES)

export type RunArtifactListingEntry = {
  path: string
  kind: 'file' | 'directory' | 'symlink'
  size: number
  linkText?: string
}

export type ArtifactReaderReply = {
  files_written?: string[] | null
  deliverables: Array<{ name: string; content: string }>
}

type RunArtifactDropReason =
  | 'copy'
  | 'dependency'
  | 'build output'
  | 'over the per-file cap'
  | 'over the total cap'
  | 'outside retention depth'
  | 'symlink'

type RunArtifactDrop = {
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

/** Ordered, deduplicated paths the parsed reply or its raw text names. */
export function namedRunArtifactPaths(
  reply: ArtifactReaderReply | null,
  rawReply: string,
  scratch: string,
  artifacts: string,
): string[] {
  const paths = [
    ...(reply?.files_written ?? []),
    ...(reply?.deliverables.flatMap(({ name, content }) =>
      [name, content].filter((value) => /(?:^|\/)\.?[^/]+\.[^/]+$/.test(value.trim())),
    ) ?? []),
  ]
  const roots = [scratch, artifacts]
  let cursor = 0
  while (cursor < rawReply.length) {
    const next = roots
      .map((root) => ({ root, index: rawReply.indexOf(root, cursor) }))
      .filter(({ index }) => index >= 0)
      .sort((a, b) => a.index - b.index)[0]
    if (!next) break
    let end = next.index + next.root.length
    while (end < rawReply.length && !/[\s"'`<>]/.test(rawReply[end]!)) end++
    paths.push(rawReply.slice(next.index, end).replace(/[),.;:]+$/, ''))
    cursor = end
  }
  return paths.filter((path, index) => paths.indexOf(path) === index)
}

function excludedDirectories(
  entries: RunArtifactListingEntry[],
): Map<string, RunArtifactDropReason> {
  const candidates = new Map<string, RunArtifactDropReason>()
  for (const entry of entries) {
    const segments = parts(entry.path)
    const name = segments.at(-1)
    if (name === '.git') {
      const copy = segments.length === 1 ? entry.path : segments.slice(0, -1).join('/')
      candidates.set(copy, 'copy')
    } else if (entry.kind === 'directory' && name && DEPENDENCY_DIRECTORIES.has(name)) {
      candidates.set(entry.path, 'dependency')
    } else if (entry.kind === 'directory' && name && BUILD_OUTPUT_DIRECTORIES.has(name)) {
      candidates.set(entry.path, 'build output')
    }
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

function recordOutsideDepthDrops(
  files: RunArtifactListingEntry[],
  namedPaths: string[],
  dropped: RunArtifactDrop[],
): Set<RunArtifactListingEntry> {
  const outside = files.filter(
    (entry) =>
      entry.path !== 'worktree.diff' &&
      !namedPaths.some((named) => atOrBelow(entry.path, named)) &&
      parts(entry.path).length > 2,
  )
  for (const [directory, group] of Map.groupBy(outside, (entry) =>
    parts(entry.path).slice(0, 2).join('/'),
  )) {
    if (group.length > OUTSIDE_DEPTH_AGGREGATE_FILE_LIMIT) {
      dropped.push({
        path: directory,
        size: group.reduce((sum, entry) => sum + entry.size, 0),
        reason: 'outside retention depth',
        fileCount: group.length,
      })
    } else {
      dropped.push(
        ...group.map((entry) => ({
          path: entry.path,
          size: entry.size,
          reason: 'outside retention depth' as const,
        })),
      )
    }
  }
  return new Set(outside)
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
  const outside = recordOutsideDepthDrops(files, namedPaths, dropped)
  const eligible = files.filter((entry) => !outside.has(entry))
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
