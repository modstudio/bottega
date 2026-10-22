// concern: setup-legacy-path
/** Detects leftover orch/hub PATH symlinks that point at this installation's matching binary. */

import { lstatSync, readlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isInstallationRoot } from '../../../shared/install-root.ts'
import type { LegacyPathSymlink } from './setup-engine.ts'

const LEGACY_PATH_COMMANDS = ['orch', 'hub'] as const

export function pathDirectories(pathValue: string | undefined): string[] {
  return (pathValue ?? '')
    .split(':')
    .filter((directory) => directory !== '' && isAbsolute(directory))
}

/** Return the resolved target when `path` is a leftover orch or hub symlink into an installation. */
export function removableLegacyPathTarget(path: string): string | null {
  const name = basename(path)
  if (name !== 'orch' && name !== 'hub') return null
  let target: string
  try {
    if (!lstatSync(path).isSymbolicLink()) return null
    target = readlinkSync(path)
  } catch {
    return null
  }
  const resolved = isAbsolute(target) ? resolve(target) : resolve(dirname(path), target)
  if (basename(resolved) !== name) return null
  const binDirectory = dirname(resolved)
  if (basename(binDirectory) !== 'bin') return null
  if (!isInstallationRoot(dirname(binDirectory))) return null
  return resolved
}

export function captureLegacyPathSymlinks(directories: readonly string[]): LegacyPathSymlink[] {
  const found: LegacyPathSymlink[] = []
  const seen = new Set<string>()
  for (const directory of directories) {
    if (!isAbsolute(directory)) continue
    for (const name of LEGACY_PATH_COMMANDS) {
      const path = join(directory, name)
      if (seen.has(path)) continue
      seen.add(path)
      const target = removableLegacyPathTarget(path)
      if (target === null) continue
      found.push({ path, target })
    }
  }
  return found
}
