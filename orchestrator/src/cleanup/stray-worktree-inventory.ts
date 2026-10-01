// concern: stray worktree directory inventory and archival
/** Observes non-git worktree-root children and archives only established candidates. */

import type { Database } from 'bun:sqlite'
import type { Dirent, Stats } from 'node:fs'
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { gitResult } from '../git/git-environment.ts'
import {
  readerCloneArchiveDirectory,
  STRAY_WORKTREE_ARCHIVE_PROJECT_MARKER,
} from './reader-clone-archive-retention.ts'
import { type StrayWorktreeDecision, strayWorktreeDecision } from './stray-worktree-decision.ts'

export type StrayWorktreeProject = { name: string; path: string }

export type StrayWorktreeDirectory = {
  project: string
  root: string
  path: string
  name: string
  modifiedMs: number
  ageMs: number
  claimed: boolean
  established: boolean
  reason: string | null
  decision: StrayWorktreeDecision
}

export type StrayWorktreeInventory = {
  directories: StrayWorktreeDirectory[]
  errors: string[]
}

const DIRECTORY_ENTRY_LIMIT = 10_000

function isWithin(path: string, root: string): boolean {
  const fromRoot = relative(root, path)
  return (
    fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith('../') && !isAbsolute(fromRoot)
  )
}

function recordedWorktreePointers(
  database: Database,
  root: string,
  resolvedRoot: string,
  canonicalize: (path: string) => string,
): Set<string> {
  const pointers = database
    .query(
      `SELECT worktree path FROM run WHERE worktree IS NOT NULL
       UNION SELECT allocation_key path FROM resource_claim WHERE kind='worktree'`,
    )
    .all() as { path: string }[]
  return new Set(
    pointers.flatMap(({ path }) => {
      const spelledPath = resolve(path)
      let resolvedPath = spelledPath
      try {
        resolvedPath = canonicalize(path)
      } catch {
        // A recorded pointer can disappear while inventory is running. Its
        // absolute spelling remains a claim if it was beneath this root.
      }
      if (!isWithin(spelledPath, resolve(root)) && !isWithin(resolvedPath, resolvedRoot)) return []
      return [spelledPath, resolvedPath]
    }),
  )
}

function listedGitWorktrees(projectPath: string): { paths: Set<string>; error: string | null } {
  const result = gitResult(['worktree', 'list', '--porcelain'], projectPath)
  if (!result.ok)
    return {
      paths: new Set(),
      error: `could not list git worktrees for ${projectPath}: ${result.stderr.trim() || 'git failed'}`,
    }
  const paths = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)))
  return { paths: new Set(paths), error: null }
}

function inspectDirectoryTree(path: string): { modifiedMs: number; reason: string | null } {
  const pending = [path]
  let modifiedMs = 0
  let inspected = 0
  while (pending.length) {
    const current = pending.pop()!
    let entries: Dirent[]
    try {
      accessSync(current, constants.R_OK)
      const metadata = lstatSync(current)
      modifiedMs = Math.max(modifiedMs, metadata.mtimeMs)
      if (metadata.isSymbolicLink()) return { modifiedMs, reason: `${current} is symlinked` }
      if (!metadata.isDirectory()) continue
      entries = readdirSync(current, { withFileTypes: true })
    } catch (error) {
      return {
        modifiedMs,
        reason: `${current} cannot be inspected: ${String((error as Error).message ?? error)}`,
      }
    }
    inspected += entries.length
    if (inspected > DIRECTORY_ENTRY_LIMIT)
      return {
        modifiedMs,
        reason: `directory inspection exceeded ${DIRECTORY_ENTRY_LIMIT} entries`,
      }
    for (const entry of entries) pending.push(join(current, entry.name))
  }
  return { modifiedMs, reason: null }
}

function unestablishedDirectory(input: {
  project: StrayWorktreeProject
  root: string
  path: string
  name: string
  nowMs: number
  reason: string
}): StrayWorktreeDirectory {
  const modifiedMs = (() => {
    try {
      return lstatSync(input.path).mtimeMs
    } catch {
      return input.nowMs
    }
  })()
  return {
    project: input.project.name,
    root: input.root,
    path: input.path,
    name: input.name,
    modifiedMs,
    ageMs: Math.max(0, input.nowMs - modifiedMs),
    claimed: false,
    established: false,
    reason: input.reason,
    decision: 'report-only',
  }
}

function observeEntry(input: {
  entry: Dirent
  project: StrayWorktreeProject
  root: string
  resolvedRoot: string
  listedPaths: Set<string>
  pointers: Set<string>
  nowMs: number
}): StrayWorktreeDirectory | null {
  const { entry, project, root, resolvedRoot, listedPaths, pointers, nowMs } = input
  const path = join(root, entry.name)
  if (!entry.isDirectory() && !entry.isSymbolicLink()) return null
  let metadata: Stats
  let resolvedPath: string
  try {
    metadata = lstatSync(path)
    resolvedPath = realpathSync(path)
    if (!statSync(path).isDirectory()) return null
  } catch (error) {
    return unestablishedDirectory({
      project,
      root,
      path,
      name: entry.name,
      nowMs,
      reason: `directory cannot be inspected: ${String((error as Error).message ?? error)}`,
    })
  }
  if (listedPaths.has(resolve(path)) || listedPaths.has(resolvedPath)) return null
  if (existsSync(join(path, '.git'))) return null
  const inspected = inspectDirectoryTree(path)
  const withinRoot = isWithin(resolvedPath, resolvedRoot)
  const established = !metadata.isSymbolicLink() && withinRoot && inspected.reason === null
  const claimed = pointers.has(resolve(path)) || pointers.has(resolvedPath)
  const modifiedMs = Math.max(metadata.mtimeMs, inspected.modifiedMs)
  const ageMs = Math.max(0, nowMs - modifiedMs)
  const reason = metadata.isSymbolicLink()
    ? 'directory is symlinked'
    : !withinRoot
      ? 'directory resolves outside the worktrees root'
      : inspected.reason
  return {
    project: project.name,
    root,
    path,
    name: entry.name,
    modifiedMs,
    ageMs,
    claimed,
    established,
    reason,
    decision: strayWorktreeDecision({ established, claimed, ageMs }),
  }
}

export function inventoryStrayWorktreeDirectories(input: {
  project: StrayWorktreeProject
  database: Database
  nowMs?: number
  canonicalizePointer?: (path: string) => string
}): StrayWorktreeInventory {
  const nowMs = input.nowMs ?? Date.now()
  const root = join(input.project.path, '.claude', 'worktrees')
  if (!existsSync(root)) return { directories: [], errors: [] }
  try {
    if (lstatSync(root).isSymbolicLink()) {
      return {
        directories: [
          unestablishedDirectory({
            project: input.project,
            root,
            path: root,
            name: basename(root),
            nowMs,
            reason: 'worktrees root is symlinked',
          }),
        ],
        errors: [],
      }
    }
    accessSync(root, constants.R_OK)
  } catch (error) {
    return {
      directories: [
        unestablishedDirectory({
          project: input.project,
          root,
          path: root,
          name: basename(root),
          nowMs,
          reason: `worktrees root is unreadable: ${String((error as Error).message ?? error)}`,
        }),
      ],
      errors: [],
    }
  }

  let resolvedRoot: string
  try {
    resolvedRoot = realpathSync(root)
  } catch (error) {
    return {
      directories: [],
      errors: [
        `could not resolve worktrees root ${root}: ${String((error as Error).message ?? error)}`,
      ],
    }
  }

  const listed = listedGitWorktrees(input.project.path)
  if (listed.error) return { directories: [], errors: [listed.error] }
  const pointers = recordedWorktreePointers(
    input.database,
    root,
    resolvedRoot,
    input.canonicalizePointer ?? realpathSync,
  )
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    return {
      directories: [],
      errors: [
        `could not read worktrees root ${root}: ${String((error as Error).message ?? error)}`,
      ],
    }
  }
  const directories = entries.flatMap((entry) => {
    const observed = observeEntry({
      entry,
      project: input.project,
      root,
      resolvedRoot,
      listedPaths: listed.paths,
      pointers,
      nowMs,
    })
    return observed ? [observed] : []
  })
  return { directories, errors: [] }
}

function archiveTimestamp(now: Date): string {
  return now.toISOString().replaceAll(':', '').replaceAll('.', '')
}

export function archiveStrayWorktreeDirectory(input: {
  directory: StrayWorktreeDirectory
  runsDirectory?: string
  now?: Date
}): { ok: true; destination: string } | { ok: false; error: string } {
  if (input.directory.decision !== 'archive')
    return { ok: false, error: `decision is ${input.directory.decision}, not archive` }
  const root = realpathSync(input.directory.root)
  const source = realpathSync(input.directory.path)
  if (!isWithin(source, root) || lstatSync(input.directory.root).isSymbolicLink())
    return {
      ok: false,
      error: `${input.directory.path} is not below a non-symlinked worktrees root`,
    }
  if (lstatSync(input.directory.path).isSymbolicLink() || existsSync(join(source, '.git')))
    return {
      ok: false,
      error: `${input.directory.path} is no longer an ordinary non-git directory`,
    }
  const archiveRoot = resolve(readerCloneArchiveDirectory(input.runsDirectory))
  const destination = resolve(
    archiveRoot,
    input.directory.project,
    `${input.directory.name}-${archiveTimestamp(input.now ?? new Date())}`,
  )
  if (!isWithin(destination, archiveRoot))
    return {
      ok: false,
      error: `archive destination ${destination} is not strictly inside ${archiveRoot}`,
    }
  try {
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(join(destination, '..', STRAY_WORKTREE_ARCHIVE_PROJECT_MARKER), '')
    try {
      renameSync(source, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      cpSync(source, destination, { recursive: true, errorOnExist: true, preserveTimestamps: true })
      rmSync(source, { recursive: true })
    }
    const archivedAt = input.now ?? new Date()
    utimesSync(destination, archivedAt, archivedAt)
    return { ok: true, destination }
  } catch (error) {
    return { ok: false, error: String((error as Error).message ?? error) }
  }
}
