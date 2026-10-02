import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeProject, upsertProject } from '../project/projects.ts'
import { preflight, seedPreflight } from './dispatch-preflight.ts'

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

test('recipe seed guidance without a default refuses an omitted seed', () => {
  const decision = seedPreflight({
    requested: undefined,
    registerChoices: ['register'],
    recipeSeeds: { choices: ['small', 'full'] },
  })
  expect(decision.seed).toBeUndefined()
  expect(decision.refusal).toContain('has no default')
  expect(decision.refusal).toContain('--seed small')
  expect(decision.refusal).not.toContain('--seed register')
})

test('recipe seed guidance fills an omitted seed from its default', () => {
  expect(
    seedPreflight({
      requested: undefined,
      registerChoices: ['register'],
      recipeSeeds: { choices: ['small', 'full'], default: 'small' },
    }),
  ).toEqual({ seed: 'small', refusal: null })
})

test('read-only jobs do not inherit or record a recipe default seed', () => {
  expect(
    seedPreflight({
      requested: undefined,
      registerChoices: ['register'],
      recipeSeeds: { choices: ['small', 'full'], default: 'small' },
      writesRepo: false,
    }),
  ).toEqual({ seed: undefined, refusal: null })
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
    name,
    path,
    settings: {
      trunk: 'main',
      worktree: { recipePath: 'worktree.jsonc', branch: 'orch/{id}' },
    },
  })

  expect(preflight('implement', path, undefined, undefined, 'base-default')).toBe('full')
})
