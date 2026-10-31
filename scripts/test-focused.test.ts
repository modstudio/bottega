import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTestReachExemptions } from './check-test-reach.ts'
import { groupFocusedTestPaths } from './test-focused.ts'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

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

test('an unreached test runs from its workspace', () => {
  const [group] = groupFocusedTestPaths(['orchestrator/src/postgres/postgres-import.test.ts'])
  expect(relative(root, group!.directory)).toBe('orchestrator')
  expect(group!.paths).toEqual(['src/postgres/postgres-import.test.ts'])
})

test('every test-reach exemption resolves to a focused run directory', () => {
  const exemptions = parseTestReachExemptions(
    readFileSync(`${root}/scripts/quality/test-reach-exemptions.json`, 'utf8'),
  )
  for (const { file } of exemptions) {
    expect(() => groupFocusedTestPaths([file]), file).not.toThrow()
  }
})

test('refuses missing and escaping path arguments', () => {
  expect(() => groupFocusedTestPaths([])).toThrow('at least one')
  expect(() => groupFocusedTestPaths(['../outside.test.ts'])).toThrow('outside the project')
  expect(() => groupFocusedTestPaths(['--watch'])).toThrow('invalid project-relative')
})
