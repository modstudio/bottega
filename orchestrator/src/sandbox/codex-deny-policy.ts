// concern: pure Codex literal read-deny policy

import { isAbsolute, relative, resolve, sep } from 'node:path'

export type CodexDirectoryListing = Readonly<Record<string, readonly string[]>>

function isAtOrBelow(path: string, ancestor: string): boolean {
  const rel = relative(ancestor, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function protectedBelow(deny: string, protectedPaths: readonly string[]): string[] {
  return protectedPaths.filter((path) => isAtOrBelow(path, deny))
}

/** Directories the launch adapter must list before the pure deny decision can run. */
export function codexDenyListingDirectories(
  denyRead: readonly string[],
  protectedPaths: readonly string[],
  opaquePaths: readonly string[] = [],
): string[] {
  const directories = new Set<string>()
  for (const deny of denyRead) {
    for (const target of protectedBelow(deny, protectedPaths)) {
      let directory = deny
      for (const component of relative(deny, target).split(sep).filter(Boolean)) {
        if (opaquePaths.some((opaque) => isAtOrBelow(directory, opaque))) break
        directories.add(directory)
        directory = resolve(directory, component)
      }
    }
  }
  return [...directories].sort()
}

/**
 * Replace a deny at or above a protected path with the literal entries beside
 * every protected path. Codex must traverse cwd and every writable root, so no
 * deny may remain at or above one of them.
 */
export function decideCodexLiteralDenyRead(input: {
  denyRead: readonly string[]
  protectedPaths: readonly string[]
  directoryListings: CodexDirectoryListing
  opaquePaths?: readonly string[]
}): string[] {
  const denied = new Set<string>()
  for (const deny of input.denyRead) {
    const targets = protectedBelow(deny, input.protectedPaths)
    if (targets.length === 0) {
      denied.add(deny)
      continue
    }
    for (const directory of codexDenyListingDirectories([deny], targets, input.opaquePaths)) {
      const entries = input.directoryListings[directory]
      if (!entries) {
        throw new Error(`Codex deny decision is missing the directory listing for ${directory}`)
      }
      for (const entry of entries) {
        const candidate = resolve(directory, entry)
        if (targets.some((target) => isAtOrBelow(target, candidate))) continue
        denied.add(candidate)
      }
    }
  }
  return [...denied].sort()
}
