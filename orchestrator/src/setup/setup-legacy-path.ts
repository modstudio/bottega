// concern: setup-legacy-path
/** Detects leftover orch/hub PATH symlinks that point into a Bottega checkout. */

import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export const LEGACY_PATH_COMMANDS = ['orch', 'hub'] as const
export type LegacyPathCommand = (typeof LEGACY_PATH_COMMANDS)[number]

export type LegacyPathSymlink = {
  path: string
  name: LegacyPathCommand
  target: string
}

export function pathDirectories(pathValue: string | undefined): string[] {
  return (pathValue ?? '').split(':').filter(Boolean)
}

function isBottegaCheckout(directory: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name?: unknown
    }
    return parsed.name === PLATFORM_SLUG
  } catch {
    return false
  }
}

/** Walk from a path toward filesystem root looking for a Bottega checkout. */
export function checkoutRootContaining(path: string): string | null {
  let directory = path
  for (;;) {
    if (isBottegaCheckout(directory)) return directory
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

export function shouldRemoveLegacyPathEntry(entry: {
  isSymbolicLink: boolean
  resolvedTarget: string
}): boolean {
  return entry.isSymbolicLink && checkoutRootContaining(entry.resolvedTarget) !== null
}

export function captureLegacyPathSymlinks(
  directories: readonly string[],
  names: readonly LegacyPathCommand[] = LEGACY_PATH_COMMANDS,
): LegacyPathSymlink[] {
  const found: LegacyPathSymlink[] = []
  const seen = new Set<string>()
  for (const directory of directories) {
    for (const name of names) {
      const path = join(directory, name)
      if (seen.has(path)) continue
      seen.add(path)
      let isSymbolicLink = false
      let target = ''
      try {
        isSymbolicLink = lstatSync(path).isSymbolicLink()
        if (!isSymbolicLink) continue
        target = readlinkSync(path)
      } catch {
        continue
      }
      const resolvedTarget = isAbsolute(target) ? target : resolve(directory, target)
      if (!shouldRemoveLegacyPathEntry({ isSymbolicLink, resolvedTarget })) continue
      found.push({ path, name, target: resolvedTarget })
    }
  }
  return found
}
