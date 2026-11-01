#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS, ROOT_TEST_FILES } from './check-plan.ts'
import { gateTestDirectories, testLegReaches } from './check-test-reach.ts'

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

function workspaceRunDirectory(path: string): string {
  return (
    packageDirectoriesByDepth.find((directory) => beneath(directory, resolve(root, path))) ?? root
  )
}

function gateReaches(path: string): boolean {
  return (
    (ROOT_TEST_FILES as readonly string[]).includes(path) ||
    CHECK_LEGS.some((leg) => testLegReaches(path, leg))
  )
}

/** Use the file's workspace when no gate leg reaches it or when the gate names that workspace. */
function gateRunDirectory(path: string): string {
  const workspaceDirectory = workspaceRunDirectory(path)
  if (!gateReaches(path)) return workspaceDirectory
  const directories = gateTestDirectories(path, ROOT_TEST_FILES, CHECK_LEGS)
  const workspace = relative(root, workspaceDirectory) || '.'
  const selected = workspace && directories.includes(workspace) ? workspace : directories[0]!
  return resolve(root, selected)
}

function typeScriptTestsUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        return ['node_modules', '.git', '.claude'].includes(entry.name)
          ? []
          : typeScriptTestsUnder(absolute)
      }
      if (!entry.isFile() || !/\.test\.tsx?$/.test(entry.name)) return []
      return [relative(root, absolute)]
    })
    .sort()
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

function addDirectorySelection(
  groups: Map<string, string[]>,
  path: string,
  absolute: string,
  tests: string[],
): void {
  const runDirectories = new Set(tests.map(gateRunDirectory))
  if (runDirectories.has(root) && runDirectories.size > 1) {
    for (const testPath of tests) {
      const runDirectory = gateRunDirectory(testPath)
      addPath(groups, runDirectory, relative(runDirectory, resolve(root, testPath)))
    }
    return
  }
  if (runDirectories.size <= 1) {
    const fallbackDirectory = workspaceRunDirectory(path)
    const runDirectory = [...runDirectories][0] ?? fallbackDirectory
    if (runDirectory === root && tests.length > 0) {
      for (const testPath of tests) addPath(groups, root, testPath)
      return
    }
    addPath(groups, runDirectory, relative(runDirectory, absolute) || '.')
    return
  }
  for (const testPath of tests) {
    const runDirectory = gateRunDirectory(testPath)
    if (beneath(absolute, runDirectory)) addPath(groups, runDirectory, '.')
    else addPath(groups, runDirectory, relative(runDirectory, resolve(root, testPath)))
  }
}

function addSelection(groups: Map<string, string[]>, path: string) {
  const absolute = selectedAbsolutePath(path)
  const projectRelativePath = relative(root, absolute)
  const directory = existsSync(absolute) && statSync(absolute).isDirectory()
  if (!directory) {
    const runDirectory = gateRunDirectory(projectRelativePath)
    addPath(groups, runDirectory, relative(runDirectory, absolute))
    return
  }
  addDirectorySelection(groups, path, absolute, typeScriptTestsUnder(absolute))
}

function focusedTestGroup(directory: string, paths: string[]): FocusedTestGroup {
  const nestedPackageIgnores = packages.flatMap((candidate) =>
    candidate.directory !== directory &&
    beneath(directory, candidate.directory) &&
    !paths.some((path) => beneath(candidate.directory, resolve(directory, path))) &&
    !typeScriptTestsUnder(candidate.directory).some((path) => gateRunDirectory(path) === directory)
      ? ['--path-ignore-patterns', `${relative(directory, candidate.directory)}/**`]
      : [],
  )
  // Plain `bun test` from the package directory loads that package's bunfig.toml and preload.
  // A package's own `test` script cannot be used: several embed a path operand (`bun test src`),
  // which bun ORs with the selected paths, so the run would not narrow.
  // Every operand is prefixed because bun reads a bare path as a substring filter.
  const operands = paths.map((path) => `./${path}`)
  return { directory, paths, argv: ['bun', 'test', ...nestedPackageIgnores, ...operands] }
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
