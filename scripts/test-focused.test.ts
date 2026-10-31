import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS, ROOT_TEST_FILES } from './check-plan.ts'
import { groupFocusedTestPaths } from './test-focused.ts'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

function beneath(directory: string, candidate: string): boolean {
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

function legReaches(path: string, leg: (typeof CHECK_LEGS)[number]): boolean {
  return (
    (leg.testDirectories.some((directory) => beneath(directory, path)) ||
      leg.testPatterns.some((pattern) => matchesPattern(pattern, path))) &&
    !leg.excludedTestDirectories.some((directory) => beneath(directory, path)) &&
    !leg.excludedTestPatterns.some((pattern) => matchesPattern(pattern, path))
  )
}

const workspaceDirectories = (
  JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { workspaces: string[] }
).workspaces
  .map((workspace) => resolve(root, workspace))
  .sort((left, right) => right.length - left.length)

function expectedGateDirectory(path: string): string {
  const rootRun =
    (ROOT_TEST_FILES as readonly string[]).includes(path) ||
    CHECK_LEGS.some((leg) => leg.directory === '.' && legReaches(path, leg))
  if (rootRun) return root
  const absolute = resolve(root, path)
  return workspaceDirectories.find((directory) => beneath(directory, absolute)) ?? root
}

function reachedTypeScriptTests(): string[] {
  const testFilesUnder = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        return ['node_modules', '.git', '.claude'].includes(entry.name) ? [] : testFilesUnder(path)
      }
      return entry.isFile() && /\.test\.tsx?$/.test(entry.name) ? [relative(root, path)] : []
    })

  return testFilesUnder(root).filter(
    (path) =>
      (ROOT_TEST_FILES as readonly string[]).includes(path) ||
      CHECK_LEGS.some((leg) => legReaches(path, leg)),
  )
}

test('groups focused paths by nearest package with package-relative arguments', () => {
  const groups = groupFocusedTestPaths([
    'hub/src/db.test.ts',
    'hub/data/src/use-task.test.ts',
    'hub/web/src/app.test.tsx',
    'hub/deploy/site/src/site.test.ts',
    'orchestrator/src/run.test.ts',
    'retrieval/src/search.test.ts',
    'shared/git.test.ts',
    'cli/routes.test.ts',
  ])
  expect(
    groups.map((group) => ({
      directory: relative(root, group.directory) || '.',
      paths: group.paths,
    })),
  ).toEqual([
    { directory: 'hub', paths: ['src/db.test.ts'] },
    { directory: 'hub/data', paths: ['src/use-task.test.ts'] },
    { directory: 'hub/web', paths: ['src/app.test.tsx'] },
    { directory: 'hub/deploy/site', paths: ['src/site.test.ts'] },
    { directory: 'orchestrator', paths: ['src/run.test.ts'] },
    { directory: 'retrieval', paths: ['src/search.test.ts'] },
    { directory: '.', paths: ['shared/git.test.ts', 'cli/routes.test.ts'] },
  ])
})

test('matches the gate directory for every reached TypeScript test file', () => {
  for (const path of reachedTypeScriptTests()) {
    const [group] = groupFocusedTestPaths([path])
    expect({ path, directory: relative(root, group!.directory) || '.' }).toEqual({
      path,
      directory: relative(root, expectedGateDirectory(path)) || '.',
    })
  }
})

test('a root-run file inside a workspace is not ignored by the root group', () => {
  const [group] = groupFocusedTestPaths(['cli/routes.test.ts'])
  expect(relative(root, group!.directory) || '.').toBe('.')
  expect(group!.argv).not.toContain('cli/**')
})

test('runs a package selection through its own test entry point without nested packages', () => {
  const [group] = groupFocusedTestPaths(['hub/src'])
  expect(relative(root, group!.directory)).toBe('hub')
  expect(group!.paths).toEqual(['src'])
  expect(group!.argv.slice(0, 2)).toEqual(['bun', 'test'])
  expect(group!.argv).toContain('data/**')

  const directoryGroups = groupFocusedTestPaths(['hub'])
  expect(directoryGroups.map((candidate) => relative(root, candidate.directory))).toContain(
    'hub/data',
  )
  expect(
    directoryGroups.find((candidate) => relative(root, candidate.directory) === 'hub/data')?.argv,
  ).toEqual(['bun', 'test', '.'])
})

test('a selection inside a package whose test script embeds a path still narrows to the selection', () => {
  const [group] = groupFocusedTestPaths(['orchestrator/src/run/run.test.ts'])
  expect(relative(root, group!.directory)).toBe('orchestrator')
  expect(group!.argv).toEqual(['bun', 'test', 'src/run/run.test.ts'])
})

test('refuses missing and escaping path arguments', () => {
  expect(() => groupFocusedTestPaths([])).toThrow('at least one')
  expect(() => groupFocusedTestPaths(['../outside.test.ts'])).toThrow('outside the project')
  expect(() => groupFocusedTestPaths(['--watch'])).toThrow('invalid project-relative')
})
