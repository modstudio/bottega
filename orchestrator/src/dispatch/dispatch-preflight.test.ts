import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeProject, upsertProject } from '../project/projects.ts'
import { assertDispatchLens, preflight } from './dispatch-preflight.ts'

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
    name,
    path,
    settings: {
      trunk: 'main',
      worktree: { recipePath: 'worktree.jsonc', branch: 'orch/{id}' },
    },
  })

  expect(preflight('implement', path, undefined, undefined, 'base-default')).toBe('full')
})

test('preflight refuses an unknown catalogue lens with the listing remedy', () => {
  expect(() => assertDispatchLens('review-lens', 'not-in-the-catalogue', null)).toThrow(
    'lens "not-in-the-catalogue" is not an enabled catalogue lens; run orch lens list',
  )
  expect(() => assertDispatchLens('review-lens-inline', 'not-in-the-catalogue', null)).not.toThrow()
})
