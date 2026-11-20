// concern: discovers and validates dependency-root read carve-backs.

import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isAtOrBelow } from './area-read-policy.ts'

function denyRoot(path: string): string {
  return path.endsWith('/*') ? path.slice(0, -2) : path
}

function areaDenyCovers(path: string, denied: string): boolean {
  const root = denyRoot(denied)
  return isAtOrBelow(path, root) && (denied === root || path !== root)
}

/** Find only node_modules symlinks below the disposable checkout. */
export function linkedNodeModules(worktree: string): string[] {
  const found = new Set<string>()
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.claude') continue
      const path = join(dir, entry.name)
      if (entry.name === 'node_modules') {
        try {
          if (lstatSync(path).isSymbolicLink()) found.add(realpathSync(path))
        } catch {
          /* a broken link is not a readable dependency root */
        }
        continue
      }
      if (entry.isDirectory()) visit(path, depth + 1)
    }
  }
  visit(worktree, 0)
  return [...found].sort()
}

/** Keep links rooted in the run project or running install and warn for every ignored link. */
export function permittedNodeModuleCarvebacks(input: {
  links: readonly string[]
  areaDenies: readonly string[]
  projectRoot?: string
  runningInstallRoot: string
  onWarning: (message: string) => void
}): string[] {
  const roots = [input.projectRoot, input.runningInstallRoot]
    .filter((root): root is string => root !== undefined)
    .map((root) => resolve(root))
  const areaDenies = input.areaDenies.map((path) => resolve(path))
  return input.links
    .map((path) => resolve(path))
    .filter((path) => {
      const admitted = roots.some(
        (root) =>
          isAtOrBelow(path, root) &&
          !areaDenies.some((denied) => {
            const deniedRoot = denyRoot(denied)
            return (
              deniedRoot !== root && isAtOrBelow(deniedRoot, root) && areaDenyCovers(path, denied)
            )
          }),
      )
      if (admitted) return true
      input.onWarning(
        `sandbox ignored node_modules link outside permitted project and running-install areas: ${path}`,
      )
      return false
    })
}
