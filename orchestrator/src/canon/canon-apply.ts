// concern: canon-hydrate
/** Applies a validated canon hydration plan to one repository tree. */
import { lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import type { HydrationPlan } from './canon-hydrate.ts'

function statOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function refuseSymlinkedAncestor(root: string, path: string): void {
  const resolvedRoot = resolve(root)
  const target = resolve(root, path)
  const within = relative(resolvedRoot, target)
  if (within.startsWith(`..${sep}`) || within === '..' || resolve(target) === resolvedRoot) {
    throw new Error(`canon hydration path is outside its root: ${path}`)
  }
  const parts = within.split(sep)
  let ancestor = resolvedRoot
  for (const part of parts.slice(0, -1)) {
    ancestor = resolve(ancestor, part)
    const stat = statOrNull(ancestor)
    if (!stat) return
    if (stat.isSymbolicLink()) {
      throw new Error(
        `refusing canon hydration through symlinked ancestor for ${path}: ${ancestor}`,
      )
    }
  }
}

export function applyHydration(root: string, plan: HydrationPlan): void {
  for (const path of plan.deletes) {
    refuseSymlinkedAncestor(root, path)
    rmSync(resolve(root, path))
  }
  for (const { path, body } of plan.writes) {
    refuseSymlinkedAncestor(root, path)
    const target = resolve(root, path)
    mkdirSync(dirname(target), { recursive: true })
    if (statOrNull(target)?.isSymbolicLink()) rmSync(target)
    writeFileSync(target, body)
  }
  for (const { path, target } of plan.links) {
    refuseSymlinkedAncestor(root, path)
    const destination = resolve(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    if (statOrNull(destination)) rmSync(destination, { recursive: true })
    symlinkSync(target, destination)
  }
}
