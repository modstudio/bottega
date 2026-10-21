// concern: storage
/** Bounded allocated-byte traversal shared by storage reporting and cleanup. */

import { lstatSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const STORAGE_WALK_ENTRY_LIMIT = 1_000_000

type StorageWalkObservation<T> = T & {
  bytes: number
  hardLinkKey: string | null
}

export type StorageWalkResult<T> = {
  observations: StorageWalkObservation<T>[]
  entries: number
  stoppedAtLimit: boolean
  errors: string[]
  unreadable: string | null
}

/** Count a multiply linked regular file only at its first path, while preserving entries. */
export function deduplicateHardLinkedBytes<T extends { bytes: number; hardLinkKey: string | null }>(
  observations: readonly T[],
): T[] {
  const seen = new Set<string>()
  return observations.map((observation) => {
    if (observation.hardLinkKey === null) return { ...observation }
    if (seen.has(observation.hardLinkKey)) return { ...observation, bytes: 0 }
    seen.add(observation.hardLinkKey)
    return { ...observation }
  })
}

type PendingEntry = { root: string; path: string }

function childrenOf(entry: PendingEntry): PendingEntry[] {
  return readdirSync(entry.path).map((name) => ({
    root: entry.root,
    path: join(entry.path, name),
  }))
}

function prepareRoots(
  roots: readonly string[],
  includeRoots: boolean,
): { pending: PendingEntry[]; unreadable: string | null } {
  const initial = [...new Set(roots.map((path) => resolve(path)))].map((path) => ({
    root: path,
    path,
  }))
  if (includeRoots) return { pending: initial, unreadable: null }
  const pending: PendingEntry[] = []
  let unreadable: string | null = null
  for (const entry of initial) {
    try {
      const stat = lstatSync(entry.path)
      if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(...childrenOf(entry))
      else pending.push(entry)
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException
      if (error.code !== 'ENOENT') unreadable ??= String(error.message ?? cause)
    }
  }
  return { pending, unreadable }
}

function inspectEntry<T>(
  entry: PendingEntry,
  classify: (root: string, relativePath: string) => T,
): {
  observation: StorageWalkObservation<T> | null
  children: PendingEntry[]
  error: string | null
} {
  try {
    const stat = lstatSync(entry.path)
    const observation = {
      bytes: typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size,
      hardLinkKey: stat.isFile() && stat.nlink > 1 ? `${stat.dev}:${stat.ino}` : null,
      ...classify(entry.root, relative(entry.root, entry.path)),
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { observation, children: [], error: null }
    }
    try {
      return { observation, children: childrenOf(entry), error: null }
    } catch (cause) {
      return {
        observation,
        children: [],
        error: `${entry.path}: ${String((cause as Error).message ?? cause)}`,
      }
    }
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException
    return {
      observation: null,
      children: [],
      error: error.code === 'ENOENT' ? null : `${entry.path}: ${String(error.message ?? cause)}`,
    }
  }
}

/** Walk roots without following symlinks, counting each hard-linked file's blocks once. */
export function walkStoragePaths<T>(
  roots: readonly string[],
  classify: (root: string, relativePath: string) => T,
  entryLimit: number,
  options: { includeRoots?: boolean } = {},
): StorageWalkResult<T> {
  const prepared = prepareRoots(roots, options.includeRoots !== false)
  const pending = prepared.pending
  const observations: StorageWalkObservation<T>[] = []
  const errors: string[] = []
  let entries = 0
  let attempted = 0

  while (pending.length > 0 && attempted < entryLimit) {
    const entry = pending.shift()!
    attempted++
    const inspected = inspectEntry(entry, classify)
    if (inspected.observation) {
      entries++
      observations.push(inspected.observation)
    }
    pending.push(...inspected.children)
    if (inspected.error) errors.push(inspected.error)
  }

  return {
    observations: deduplicateHardLinkedBytes(observations),
    entries,
    stoppedAtLimit: pending.length > 0,
    errors,
    unreadable: prepared.unreadable,
  }
}
