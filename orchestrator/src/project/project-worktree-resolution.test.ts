import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { DEFAULT_PROJECT_CONFIG_PATH } from '../worktree/worktree-lifecycle.ts'
import type { WorktreeTool } from './project-settings.ts'
import { projectLifecycleForm, resolvedWorktreeTool } from './project-worktree-resolution.ts'

const project = (worktree?: WorktreeTool) => ({
  path: '/projects/alpha',
  settings: { worktree },
})

test('project lifecycle forms follow declarations and the repository-local default', () => {
  expect(projectLifecycleForm(project({ create: { command: 'make', args: [] } }))).toBe(
    'command-templates',
  )
  expect(projectLifecycleForm(project({ remove: 'remove', sweep: 'sweep' }))).toBe('none')
  expect(projectLifecycleForm(project({ recipe: {} }))).toBe('inline-recipe')
  expect(projectLifecycleForm(project({ recipePath: '.orch/worktree.jsonc' }))).toBe(
    'tracked-recipe',
  )
  expect(projectLifecycleForm(project({}))).toBe('none')
  expect(projectLifecycleForm(project())).toBe('none')
})

test('one default-config resolution drives the listed form and execution tool', () => {
  const candidate = project()
  const defaultPath = resolve(candidate.path, DEFAULT_PROJECT_CONFIG_PATH)
  const fileExists = (path: string) => path === defaultPath
  expect(projectLifecycleForm(candidate, fileExists)).toBe('tracked-recipe')
  expect(resolvedWorktreeTool(candidate, fileExists)).toEqual({
    recipePath: DEFAULT_PROJECT_CONFIG_PATH,
  })
})
