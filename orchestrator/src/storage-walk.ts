// concern: storage
/** Bounded allocated-byte traversal shared by storage reporting and cleanup. */

import { lstatSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const STORAGE_WALK_ENTRY_LIMIT = 1_000_000

export type StorageWalkObservation<T> = T & {
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

/** Walk roots without following symlinks, counting each hard-linked file's blocks once. */
export function walkStoragePaths<T>(
  roots: readonly string[],
  classify: (root: string, relativePath: string) => T,
  entryLimit: number,
  options: { includeRoots?: boolean } = {},
): StorageWalkResult<T> {
  let pending = [...new Set(roots.map((path) => resolve(path)))].map((path) => ({
    root: path,
    path,
  }))
  const observations: StorageWalkObservation<T>[] = []
  const errors: string[] = []
  const seenHardLinks = new Set<string>()
  let entries = 0
  let attempted = 0
  let unreadable: string | null = null

  if (options.includeRoots === false) {
    const children: typeof pending = []
    for (const entry of pending) {
      try {
        const stat = lstatSync(entry.path)
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          children.push(entry)
          continue
        }
        children.push(
          ...readdirSync(entry.path).map((name) => ({
            root: entry.root,
            path: join(entry.path, name),
          })),
        )
      } catch (cause) {
        const error = cause as NodeJS.ErrnoException
        if (error.code !== 'ENOENT') unreadable ??= String(error.message ?? cause)
      }
    }
    pending = children
  }

  while (pending.length > 0 && attempted < entryLimit) {
    const entry = pending.shift()!
    attempted++
    try {
      const stat = lstatSync(entry.path)
      entries++
      const hardLinkKey = stat.isFile() && stat.nlink > 1 ? `${stat.dev}:${stat.ino}` : null
      const duplicate = hardLinkKey !== null && seenHardLinks.has(hardLinkKey)
      if (hardLinkKey !== null) seenHardLinks.add(hardLinkKey)
      observations.push({
        bytes: duplicate ? 0 : typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size,
        hardLinkKey,
        ...classify(entry.root, relative(entry.root, entry.path)),
      })
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        try {
          pending.push(
            ...readdirSync(entry.path).map((name) => ({
              root: entry.root,
              path: join(entry.path, name),
            })),
          )
        } catch (cause) {
          errors.push(`${entry.path}: ${String((cause as Error).message ?? cause)}`)
        }
      }
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException
      if (error.code === 'ENOENT') continue
      const detail = String(error.message ?? cause)
      if (entry.path === entry.root && roots.length === 1) unreadable ??= detail
      else errors.push(`${entry.path}: ${detail}`)
    }
  }

  return {
    observations: deduplicateHardLinkedBytes(observations),
    entries,
    stoppedAtLimit: pending.length > 0,
    errors,
    unreadable,
  }
}
