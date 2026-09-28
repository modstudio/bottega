// concern: canon-hydrate
/** Applies a previously validated canon hydration plan to one repository tree. */
import { lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { HydrationPlan } from './canon-hydrate.ts'

function statOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function applyHydration(root: string, plan: HydrationPlan): void {
  for (const path of plan.deletes) rmSync(resolve(root, path))
  for (const { path, body } of plan.writes) {
    const target = resolve(root, path)
    mkdirSync(dirname(target), { recursive: true })
    if (statOrNull(target)?.isSymbolicLink()) rmSync(target)
    writeFileSync(target, body)
  }
  for (const { path, target } of plan.links) {
    const destination = resolve(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    if (statOrNull(destination)) rmSync(destination, { recursive: true })
    symlinkSync(target, destination)
  }
}
