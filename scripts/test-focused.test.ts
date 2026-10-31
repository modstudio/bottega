import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS, ROOT_TEST_FILES } from './check-plan.ts'
import { gateTestDirectories, testLegReaches } from './check-test-reach.ts'
import { groupFocusedTestPaths } from './test-focused.ts'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

function trackedTypeScriptTests(): string[] {
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
      CHECK_LEGS.some((leg) => testLegReaches(path, leg)),
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

test('every TypeScript test file resolves to a declared gate directory', () => {
  for (const path of trackedTypeScriptTests()) {
    expect(gateTestDirectories(path, ROOT_TEST_FILES, CHECK_LEGS).length, path).toBeGreaterThan(0)
  }
})

test('pins focused directories at each gate-directory boundary', () => {
  const cases = [
    ['cli/routes.test.ts', '.'],
    ['hub/ui/src/state/pagination.test.ts', 'hub'],
    ['hub/site/src/chrome.test.tsx', 'hub/site'],
    ['orchestrator/src/porting/porting.test.ts', 'orchestrator'],
    ['shared/state-directory.test.ts', '.'],
  ] as const
  for (const [path, expectedDirectory] of cases) {
    const [group] = groupFocusedTestPaths([path])
    expect(relative(root, group!.directory) || '.', path).toBe(expectedDirectory)
  }
})

test('a root-run file inside a workspace is not ignored by the root group', () => {
  const [group] = groupFocusedTestPaths(['cli/routes.test.ts'])
  expect(relative(root, group!.directory) || '.').toBe('.')
  expect(group!.argv).toContain('./cli/routes.test.ts')
  expect(group!.argv).not.toContain('cli/**')
})

test('a directory containing only root-run tests runs from the root', () => {
  const [group] = groupFocusedTestPaths(['cli'])
  expect(relative(root, group!.directory) || '.').toBe('.')
  expect(group!.argv.slice(-3)).toEqual([
    './cli/dispatch.test.ts',
    './cli/legacy-calls.test.ts',
    './cli/routes.test.ts',
  ])
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
