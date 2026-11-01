#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS, CI_ONLY_SUITES, ROOT_TEST_FILES } from './check-plan.ts'
import { gateTestDirectories, matchesTestPattern, testLegReaches } from './check-test-reach.ts'

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

type FocusedForm = { directory: string; argv: readonly string[] }
export type FocusedSuiteOwner = {
  owner: string
  testPatterns: readonly string[]
  focused?: FocusedForm
}

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

export function focusedSuiteOwners(): FocusedSuiteOwner[] {
  const checkLegSuites = CHECK_LEGS.filter((leg) => leg.testPatterns.length > 0).map((leg) => {
    const suite = leg.suite.find((candidate) => 'focused' in candidate)
    return {
      owner: `CHECK_LEGS leg ${JSON.stringify(leg.name)}`,
      testPatterns: leg.testPatterns,
      focused: suite && 'focused' in suite ? suite.focused : undefined,
    }
  })
  return [
    ...checkLegSuites,
    ...CI_ONLY_SUITES.map((suite) => ({
      owner: `CI_ONLY_SUITES job ${JSON.stringify(suite.job)}`,
      testPatterns: suite.testPatterns,
      focused: 'focused' in suite ? suite.focused : undefined,
    })),
  ]
}

const suiteOwners = focusedSuiteOwners()

export function suiteOwnerClaiming(path: string): FocusedSuiteOwner | undefined {
  return suiteOwners.find((suite) =>
    suite.testPatterns.some((pattern) => matchesTestPattern(pattern, path)),
  )
}

function focusedSuiteFor(path: string): (FocusedSuiteOwner & { focused: FocusedForm }) | undefined {
  const suite = suiteOwnerClaiming(path)
  return suite?.focused ? (suite as FocusedSuiteOwner & { focused: FocusedForm }) : undefined
}

function claimedPythonTestsUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        return ['node_modules', '.git', '.claude'].includes(entry.name)
          ? []
          : claimedPythonTestsUnder(absolute)
      }
      if (!entry.isFile()) return []
      const path = relative(root, absolute)
      return focusedSuiteFor(path) ? [path] : []
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

function addBunSelection(groups: Map<string, string[]>, absolute: string) {
  const projectRelativePath = relative(root, absolute)
  const runDirectory = gateRunDirectory(projectRelativePath)
  addPath(groups, runDirectory, relative(runDirectory, absolute))
}

function focusedGroupKey(form: FocusedForm): string {
  return JSON.stringify([form.directory, form.argv])
}

function addFocusedSelection(
  groups: Map<string, { form: FocusedForm; modules: string[] }>,
  suite: FocusedSuiteOwner & { focused: FocusedForm },
  path: string,
) {
  const key = focusedGroupKey(suite.focused)
  const group = groups.get(key) ?? { form: suite.focused, modules: [] }
  const module = basename(path, '.py')
  if (!group.modules.includes(module)) group.modules.push(module)
  groups.set(key, group)
}

type RefusedSelection = { path: string; reason: 'missing' | 'unclaimed' }

function refusal(refused: readonly RefusedSelection[]): Error {
  const missing = refused.filter(({ reason }) => reason === 'missing').map(({ path }) => path)
  const unclaimed = refused.filter(({ reason }) => reason === 'unclaimed').map(({ path }) => path)
  const messages: string[] = []
  if (missing.length > 0) {
    messages.push(
      `${missing.map((path) => JSON.stringify(path)).join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist in this tree.`,
    )
  }
  if (unclaimed.length > 0) {
    const patterns = [...new Set(focusedSuiteOwners().flatMap((suite) => suite.testPatterns))]
    messages.push(
      `No runner claims ${unclaimed.map((path) => JSON.stringify(path)).join(', ')}. ` +
        `Run *.test.ts(x) files or files matching a declared suite pattern: ${patterns.join(', ')}.`,
    )
  }
  return new Error(`run_tests cannot run: ${messages.join(' ')}`)
}

function addSelection(
  bunGroups: Map<string, string[]>,
  focusedGroups: Map<string, { form: FocusedForm; modules: string[] }>,
  path: string,
): RefusedSelection[] {
  const absolute = selectedAbsolutePath(path)
  const projectRelativePath = relative(root, absolute)
  if (!existsSync(absolute)) return [{ path, reason: 'missing' }]
  const directory = statSync(absolute).isDirectory()
  if (!directory) {
    const focusedSuite = focusedSuiteFor(projectRelativePath)
    if (focusedSuite) addFocusedSelection(focusedGroups, focusedSuite, projectRelativePath)
    else if (/\.test\.tsx?$/.test(projectRelativePath)) addBunSelection(bunGroups, absolute)
    else return [{ path, reason: 'unclaimed' }]
    return []
  }
  const typeScriptTests = typeScriptTestsUnder(absolute)
  const pythonTests = claimedPythonTestsUnder(absolute)
  if (typeScriptTests.length > 0) addDirectorySelection(bunGroups, path, absolute, typeScriptTests)
  for (const pythonPath of pythonTests) {
    addFocusedSelection(focusedGroups, focusedSuiteFor(pythonPath)!, pythonPath)
  }
  return typeScriptTests.length === 0 && pythonTests.length === 0
    ? [{ path, reason: 'unclaimed' }]
    : []
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
  const bunGroups = new Map<string, string[]>()
  const focusedGroups = new Map<string, { form: FocusedForm; modules: string[] }>()
  const refused = paths.flatMap((path) => addSelection(bunGroups, focusedGroups, path))
  if (refused.length > 0) throw refusal(refused)
  return [
    ...focusedGroups.values().map(({ form, modules }) => ({
      directory: resolve(root, form.directory),
      paths: modules,
      argv: [...form.argv, ...modules],
    })),
    ...[...bunGroups].map(([directory, groupedPaths]) => focusedTestGroup(directory, groupedPaths)),
  ]
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
