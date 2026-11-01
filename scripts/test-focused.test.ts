import { expect, test } from 'bun:test'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { groupFocusedTestPaths } from './test-focused.ts'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

test('groups focused paths by nearest package with package-relative arguments', () => {
  const groups = groupFocusedTestPaths([
    'hub/src/db.test.ts',
    'hub/data/src/use-task.test.ts',
    'hub/web/src/routes/notes.test.tsx',
    'hub/deploy/site/src/decision.test.ts',
    'orchestrator/src/run/exec.test.ts',
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
    { directory: 'hub/web', paths: ['src/routes/notes.test.tsx'] },
    { directory: 'hub/deploy/site', paths: ['src/decision.test.ts'] },
    { directory: 'orchestrator', paths: ['src/run/exec.test.ts'] },
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
  ).toEqual(['bun', 'test', './.'])
})

test('a selection inside a package whose test script embeds a path still narrows to the selection', () => {
  const [group] = groupFocusedTestPaths(['orchestrator/src/run/exec.test.ts'])
  expect(relative(root, group!.directory)).toBe('orchestrator')
  expect(group!.argv).toEqual(['bun', 'test', './src/run/exec.test.ts'])
})

test('an unreached test runs from its workspace', () => {
  const [group] = groupFocusedTestPaths(['orchestrator/src/postgres/postgres-import.test.ts'])
  expect(relative(root, group!.directory)).toBe('orchestrator')
  expect(group!.paths).toEqual(['src/postgres/postgres-import.test.ts'])
})

test('routes a hook test through unittest from the hooks directory', () => {
  const [group] = groupFocusedTestPaths(['orchestrator/hooks/test_secret_shaped_parity.py'])
  expect(relative(root, group!.directory)).toBe('orchestrator/hooks')
  expect(group!.paths).toEqual(['test_secret_shaped_parity'])
  expect(group!.argv).toEqual(['python3', '-m', 'unittest', 'test_secret_shaped_parity'])
})

test('routes a hook process test through unittest from the hooks directory', () => {
  const [group] = groupFocusedTestPaths(['orchestrator/hooks/process_heartbeat_shell.py'])
  expect(relative(root, group!.directory)).toBe('orchestrator/hooks')
  expect(group!.paths).toEqual(['process_heartbeat_shell'])
  expect(group!.argv).toEqual(['python3', '-m', 'unittest', 'process_heartbeat_shell'])
})

test('groups mixed Python and TypeScript selections by runner', () => {
  const groups = groupFocusedTestPaths([
    'orchestrator/hooks/test_secret_shaped_parity.py',
    'scripts/test-focused.test.ts',
  ])
  expect(groups).toHaveLength(2)
  expect(groups[0]!.argv).toEqual(['python3', '-m', 'unittest', 'test_secret_shaped_parity'])
  expect(groups[1]!.argv).toContain('./scripts/test-focused.test.ts')
})

test('a hooks directory selection includes every claimed Python suite', () => {
  const [group] = groupFocusedTestPaths(['orchestrator/hooks'])
  expect(relative(root, group!.directory)).toBe('orchestrator/hooks')
  expect(group!.argv).toContain('test_secret_shaped_parity')
  expect(group!.argv).toContain('process_heartbeat_shell')
  expect(group!.paths.every((module) => /^(?:test_|process_)/.test(module))).toBe(true)
  expect(group!.paths).not.toContain('heartbeat_decision_fixture')
})

test('refuses paths that no focused runner owns', () => {
  expect(() =>
    groupFocusedTestPaths([
      'orchestrator/hooks/heartbeat_decision_fixture.py',
      'scripts/check-plan.ts',
    ]),
  ).toThrow(/heartbeat_decision_fixture\.py.*scripts\/check-plan\.ts/)
})

test('a directory mixing root-run and workspace-run tests expands into both groups', () => {
  const groups = groupFocusedTestPaths(['orchestrator/src/postgres'])
  expect(
    groups.map((group) => ({
      directory: relative(root, group.directory) || '.',
      paths: group.paths,
    })),
  ).toEqual([
    {
      directory: '.',
      paths: [
        'orchestrator/src/postgres/migration-failure.test.ts',
        'orchestrator/src/postgres/postgres-migrate.test.ts',
      ],
    },
    {
      directory: 'orchestrator',
      paths: [
        'src/postgres/postgres-import.test.ts',
        'src/postgres/postgres-migrate-board-shared-space.test.ts',
        'src/postgres/postgres-migrate-doc-latest-revision.test.ts',
        'src/postgres/postgres-migrate-doc-revision-author.test.ts',
        'src/postgres/postgres-migrate-hosted-project-cleanup.test.ts',
        'src/postgres/postgres-migrate-hosted-task-ids.test.ts',
        'src/postgres/postgres-migrate-hub-project-identity.test.ts',
        'src/postgres/postgres-migrate-jsonb-binding.test.ts',
        'src/postgres/postgres-migrate-public-role.test.ts',
        'src/postgres/postgres-migrate-read-only.test.ts',
        'src/postgres/postgres-migrate-recipients.test.ts',
        'src/postgres/postgres-migrate-rls.test.ts',
        'src/postgres/postgres-migrate-schema.test.ts',
        'src/postgres/postgres-migrate-workflow-generation.test.ts',
      ],
    },
  ])
  expect(groups[0]!.argv.slice(-2)).toEqual([
    './orchestrator/src/postgres/migration-failure.test.ts',
    './orchestrator/src/postgres/postgres-migrate.test.ts',
  ])
})

test('refuses missing and escaping path arguments', () => {
  expect(() => groupFocusedTestPaths([])).toThrow('at least one')
  expect(() => groupFocusedTestPaths(['../outside.test.ts'])).toThrow('outside the project')
  expect(() => groupFocusedTestPaths(['--watch'])).toThrow('invalid project-relative')
  expect(() => groupFocusedTestPaths(['scripts/missing.test.ts'])).toThrow(
    'run_tests cannot run: "scripts/missing.test.ts" does not exist in this tree.',
  )
})

test('distinguishes missing paths from paths no runner claims', () => {
  expect(() => groupFocusedTestPaths(['scripts/missing.test.ts', 'scripts/check-plan.ts'])).toThrow(
    'run_tests cannot run: "scripts/missing.test.ts" does not exist in this tree. No runner claims "scripts/check-plan.ts". Run *.test.ts(x) files or files matching a declared suite pattern: orchestrator/hooks/test_*.py, orchestrator/hooks/process_*.py.',
  )
})
