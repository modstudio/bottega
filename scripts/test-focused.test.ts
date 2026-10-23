import { expect, test } from 'bun:test'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    { directory: '.', paths: ['shared/git.test.ts'] },
  ])
})

test('runs a package selection through its own test entry point without nested packages', () => {
  const [group] = groupFocusedTestPaths(['hub/src'])
  expect(relative(root, group.directory)).toBe('hub')
  expect(group.paths).toEqual(['src'])
  expect(group.argv.slice(0, 2)).toEqual(['bun', 'test'])
  expect(group.argv).toContain('data/**')

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
  expect(relative(root, group.directory)).toBe('orchestrator')
  expect(group.argv).toEqual(['bun', 'test', 'src/run/run.test.ts'])
})

test('refuses missing and escaping path arguments', () => {
  expect(() => groupFocusedTestPaths([])).toThrow('at least one')
  expect(() => groupFocusedTestPaths(['../outside.test.ts'])).toThrow('outside the project')
  expect(() => groupFocusedTestPaths(['--watch'])).toThrow('invalid project-relative')
})
