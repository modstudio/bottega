import type { Database } from 'bun:sqlite'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { type Project, projectAt } from './project/projects.ts'

type RegisteredProject = Pick<Project, 'name' | 'path'>

export type RegisteredCheckoutTarget = {
  checkout: string
  file: string
}

function within(root: string, path: string) {
  const value = relative(root, path)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

function canonicalTarget(path: string): string | null {
  const target = lstatSync(path, { throwIfNoEntry: false })
  if (target?.isSymbolicLink()) return null
  if (target) {
    try {
      return realpathSync(path)
    } catch {
      return null
    }
  }

  const missing: string[] = []
  let ancestor = path
  while (true) {
    const fact = lstatSync(ancestor, { throwIfNoEntry: false })
    if (fact) {
      try {
        return resolve(realpathSync(ancestor), ...missing.reverse())
      } catch {
        return null
      }
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) return null
    missing.push(basename(ancestor))
    ancestor = parent
  }
}

/** Resolves a target inside the registered Bottega checkout (main or a sibling worktree). */
export function registeredBottegaCheckout(
  file: string,
  project: RegisteredProject | null,
): RegisteredCheckoutTarget | null {
  if (!project || project.name !== PLATFORM_SLUG || !within(project.path, file)) return null
  const projectRelative = relative(project.path, file).split(sep)
  const lexicalCheckout =
    projectRelative[0] === '.claude' && projectRelative[1] === 'worktrees' && projectRelative[2]
      ? join(project.path, ...projectRelative.slice(0, 3))
      : project.path
  let projectRoot: string
  let checkout: string
  try {
    projectRoot = realpathSync(project.path)
    checkout = realpathSync(lexicalCheckout)
  } catch {
    return null
  }
  if (checkout !== projectRoot && !within(projectRoot, checkout)) return null
  const canonicalFile = canonicalTarget(file)
  if (!canonicalFile || !within(checkout, canonicalFile)) return null
  return { checkout, file: canonicalFile }
}

export function registeredCheckoutForFile(
  file: string,
  database: Database,
): RegisteredCheckoutTarget | null {
  return registeredBottegaCheckout(file, projectAt(file, database))
}
