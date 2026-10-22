import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { removeProject, upsertProject } from '../project/projects.ts'
import { lensDispatchNotices } from './dispatch-commands.ts'
import { preflight, sourceIsRegisteredMain } from './dispatch-preflight.ts'

const fixtures: { name: string; path: string }[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    removeProject(fixture.name)
    rmSync(fixture.path, { recursive: true, force: true })
  }
})

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

test('the registered main checkout is the main source', () => {
  expect(
    sourceIsRegisteredMain({
      sourceToplevel: '/projects/example',
      sourceRepoRoot: '/projects/example',
      borrowedFromMain: null,
      registeredMainPath: '/projects/example',
    }),
  ).toBe(true)
})

test('a linked worktree of the registered repository is not the main source', () => {
  expect(
    sourceIsRegisteredMain({
      sourceToplevel: '/projects/example/.claude/worktrees/EX-1',
      sourceRepoRoot: '/projects/example',
      borrowedFromMain: null,
      registeredMainPath: '/projects/example',
    }),
  ).toBe(false)
})

test('a clone borrowing from the registered repository is not the main source', () => {
  expect(
    sourceIsRegisteredMain({
      sourceToplevel: '/tmp/borrowed-example',
      sourceRepoRoot: '/projects/example',
      borrowedFromMain: '/projects/example',
      registeredMainPath: '/projects/example',
    }),
  ).toBe(false)
})

test('a cwd outside the registered project uses its main checkout as the source', () => {
  expect(
    sourceIsRegisteredMain({
      sourceToplevel: '/projects/other',
      sourceRepoRoot: '/projects/other',
      borrowedFromMain: null,
      registeredMainPath: '/projects/example',
    }),
  ).toBe(true)
})

test('a registered main path longer than 200 characters is still the main source', () => {
  const registeredMainPath = `/projects/${'long-segment/'.repeat(20)}example`
  expect(registeredMainPath.length).toBeGreaterThan(200)
  expect(
    sourceIsRegisteredMain({
      sourceToplevel: registeredMainPath,
      sourceRepoRoot: registeredMainPath,
      borrowedFromMain: null,
      registeredMainPath,
    }),
  ).toBe(true)
})

test('preflight uses the recipe default from the explicit base creation will use', () => {
  const path = mkdtempSync(join(tmpdir(), 'orch-seed-base-'))
  const name = `seed-base-${Date.now()}-${Math.random()}`
  fixtures.push({ name, path })
  git(path, 'init', '-b', 'main')
  git(path, 'config', 'user.email', 'fixture@example.test')
  git(path, 'config', 'user.name', 'Fixture')
  writeFileSync(
    join(path, 'worktree.jsonc'),
    '{"worktree":{"create":[],"seeds":{"choices":["small"],"default":"small"}}}',
  )
  git(path, 'add', 'worktree.jsonc')
  git(path, 'commit', '-m', 'main recipe')
  git(path, 'checkout', '-b', 'base-default')
  writeFileSync(
    join(path, 'worktree.jsonc'),
    '{"worktree":{"create":[],"seeds":{"choices":["full"],"default":"full"}}}',
  )
  git(path, 'commit', '-am', 'base recipe')
  git(path, 'checkout', 'main')
  upsertProject({
    recordId: newRecordId(),
    name,
    path,
    settings: {
      trunk: 'main',
      worktree: { recipePath: 'worktree.jsonc', branch: 'orch/{id}' },
    },
  })

  expect(preflight('implement', path, undefined, undefined, 'base-default')).toBe('full')
})

test('unknown catalogue lens passes preflight and produces a caller-prompt notice', () => {
  expect(() =>
    preflight(
      'review-lens',
      process.cwd(),
      undefined,
      undefined,
      undefined,
      true,
      true,
      'not-in-the-catalogue',
      undefined,
      false,
      undefined,
      true,
    ),
  ).not.toThrow()
  expect(
    lensDispatchNotices({
      jobName: 'review-lens',
      lens: 'not-in-the-catalogue',
      resolved: null,
      stack: 'node',
    }),
  ).toEqual([
    `! lens not-in-the-catalogue has no catalogue row and runs with the caller's prompt only; ${PLATFORM_SLUG} review lens list shows the catalogue`,
  ])
})
