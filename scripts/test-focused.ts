#!/usr/bin/env bun
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const nestedPackageDirectories = [
  'hub/deploy/site',
  'hub/web',
  'orchestrator',
  'hub',
  'retrieval',
] as const

export type FocusedTestGroup = { directory: string; paths: string[] }

function beneath(directory: string, candidate: string) {
  const offset = relative(directory, candidate)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

export function groupFocusedTestPaths(paths: readonly string[]): FocusedTestGroup[] {
  if (paths.length === 0) throw new Error('provide at least one project-relative test path')
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    if (!path || path.startsWith('-') || isAbsolute(path)) {
      throw new Error(`invalid project-relative test path ${JSON.stringify(path)}`)
    }
    const absolute = resolve(root, path)
    if (!beneath(root, absolute)) {
      throw new Error(`test path ${JSON.stringify(path)} resolves outside the project`)
    }
    const packageDirectory =
      nestedPackageDirectories
        .map((directory) => resolve(root, directory))
        .find((directory) => beneath(directory, absolute)) ?? root
    const grouped = groups.get(packageDirectory) ?? []
    grouped.push(relative(packageDirectory, absolute))
    groups.set(packageDirectory, grouped)
  }
  return [...groups].map(([directory, groupedPaths]) => ({ directory, paths: groupedPaths }))
}

export async function runFocusedTests(paths: readonly string[]): Promise<number> {
  let failed = false
  for (const group of groupFocusedTestPaths(paths)) {
    const child = Bun.spawn(['bun', 'test', ...group.paths], {
      cwd: group.directory,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await child.exited) !== 0) failed = true
  }
  return failed ? 1 : 0
}

if (import.meta.main) {
  try {
    process.exit(await runFocusedTests(Bun.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
