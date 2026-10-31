#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS, ROOT_TEST_FILES } from './check-plan.ts'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

type WorkspacePackage = { directory: string }

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
    .map((directory) => ({ directory }))
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

function matchesPattern(pattern: string, path: string): boolean {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${expression}$`).test(path)
}

function reachedByLeg(path: string, leg: (typeof CHECK_LEGS)[number]): boolean {
  return (
    (leg.testDirectories.some((directory) => beneath(directory, path)) ||
      leg.testPatterns.some((pattern) => matchesPattern(pattern, path))) &&
    !leg.excludedTestDirectories.some((directory) => beneath(directory, path)) &&
    !leg.excludedTestPatterns.some((pattern) => matchesPattern(pattern, path))
  )
}

/** A root-run test must inherit the root bunfig even when it lives in a nested workspace. */
function gateRunsTestFromRoot(path: string): boolean {
  return (
    (ROOT_TEST_FILES as readonly string[]).includes(path) ||
    CHECK_LEGS.some((leg) => leg.directory === '.' && reachedByLeg(path, leg))
  )
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
  const projectRelativePath = relative(root, absolute)
  const packageDirectory = gateRunsTestFromRoot(projectRelativePath)
    ? root
    : (packageDirectoriesByDepth.find((directory) => beneath(directory, absolute)) ?? root)
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
    candidate.directory !== directory &&
    beneath(directory, candidate.directory) &&
    !paths.some((path) => beneath(candidate.directory, resolve(directory, path)))
      ? ['--path-ignore-patterns', `${relative(directory, candidate.directory)}/**`]
      : [],
  )
  // Plain `bun test` from the package directory loads that package's bunfig.toml and preload.
  // A package's own `test` script cannot be used: several embed a path operand (`bun test src`),
  // which bun ORs with the selected paths, so the run would not narrow.
  return { directory, paths, argv: ['bun', 'test', ...nestedPackageIgnores, ...paths] }
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
