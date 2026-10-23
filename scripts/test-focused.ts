#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

type WorkspacePackage = { directory: string; hasTestScript: boolean }

/** The root package's declared workspaces are the package boundaries; no tree walk, no node_modules. */
function workspacePackages(): WorkspacePackage[] {
  const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    workspaces?: string[]
  }
  const directories = new Set([
    root,
    ...(rootManifest.workspaces ?? []).map((workspace) => resolve(root, workspace)),
  ])
  return [...directories]
    .map((directory) => {
      const manifest = resolve(directory, 'package.json')
      if (!existsSync(manifest)) return { directory, hasTestScript: false }
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
        scripts?: { test?: unknown }
      }
      return { directory, hasTestScript: typeof parsed.scripts?.test === 'string' }
    })
    .sort((left, right) => left.directory.localeCompare(right.directory))
}

const packages = workspacePackages()
const packageDirectoriesByDepth = packages
  .map(({ directory }) => directory)
  .sort((left, right) => right.length - left.length)

export type FocusedTestGroup = { directory: string; paths: string[]; argv: string[] }

function beneath(directory: string, candidate: string) {
  const offset = relative(directory, candidate)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

function selectedAbsolutePath(path: string): string {
  if (!path || path.startsWith('-') || isAbsolute(path)) {
    throw new Error(`invalid project-relative test path ${JSON.stringify(path)}`)
  }
  const absolute = resolve(root, path)
  if (!beneath(root, absolute)) {
    throw new Error(`test path ${JSON.stringify(path)} resolves outside the project`)
  }
  return absolute
}

function addPath(groups: Map<string, string[]>, directory: string, path: string) {
  const grouped = groups.get(directory) ?? []
  if (!grouped.includes(path)) grouped.push(path)
  groups.set(directory, grouped)
}

function addSelection(groups: Map<string, string[]>, path: string) {
  const absolute = selectedAbsolutePath(path)
  const packageDirectory =
    packageDirectoriesByDepth.find((directory) => beneath(directory, absolute)) ?? root
  addPath(groups, packageDirectory, relative(packageDirectory, absolute) || '.')
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return
  for (const nested of packages) {
    if (nested.directory !== packageDirectory && beneath(absolute, nested.directory)) {
      addPath(groups, nested.directory, '.')
    }
  }
}

function focusedTestGroup(directory: string, paths: string[]): FocusedTestGroup {
  const nestedPackageIgnores = packages.flatMap((candidate) =>
    candidate.directory !== directory && beneath(directory, candidate.directory)
      ? ['--path-ignore-patterns', `${relative(directory, candidate.directory)}/**`]
      : [],
  )
  const entryPoint = packages.find((candidate) => candidate.directory === directory)?.hasTestScript
    ? ['bun', 'run', 'test', '--']
    : ['bun', 'test']
  return { directory, paths, argv: [...entryPoint, ...nestedPackageIgnores, ...paths] }
}

export function groupFocusedTestPaths(paths: readonly string[]): FocusedTestGroup[] {
  if (paths.length === 0) throw new Error('provide at least one project-relative test path')
  const groups = new Map<string, string[]>()
  for (const path of paths) addSelection(groups, path)
  return [...groups].map(([directory, groupedPaths]) => focusedTestGroup(directory, groupedPaths))
}

async function runFocusedTests(paths: readonly string[]): Promise<number> {
  let failed = false
  for (const group of groupFocusedTestPaths(paths)) {
    const child = Bun.spawn(group.argv, {
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
