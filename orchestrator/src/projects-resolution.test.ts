import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectAt, stackAt, upsertProject, validateProjectSettings } from './projects.ts'

let projectDirectory: string | null = null

afterEach(() => {
  if (projectDirectory) rmSync(projectDirectory, { recursive: true, force: true })
  projectDirectory = null
})

describe('projects are data, not code', () => {
  test('a directory belongs to the project that contains it', () => {
    upsertProject({ name: 'alpha', path: '/w/alpha', stack: 'php-laravel' })
    expect(projectAt('/w/alpha')?.name).toBe('alpha')
    expect(projectAt('/w/alpha/src/deep/file')?.name).toBe('alpha')
    // The case the old path regex could never handle, and the reason
    // containment beats pattern-matching: a worktree lives inside its project.
    expect(projectAt('/w/alpha/.claude/worktrees/orch-12')?.name).toBe('alpha')
    expect(stackAt('/w/alpha/.claude/worktrees/orch-12')).toBe('php-laravel')
  })

  test('an unregistered directory is null, not a guess', () => {
    upsertProject({ name: 'alpha', path: '/w/alpha' })
    expect(projectAt('/somewhere/else')).toBeNull()
    // Not '/w/alphabet': containment must respect the path separator, or a
    // project named as a prefix of another would swallow it.
    expect(projectAt('/w/alphabet')).toBeNull()
  })

  test('the longest matching path wins, so nesting resolves inward', () => {
    upsertProject({ name: 'outer', path: '/w' })
    upsertProject({ name: 'inner', path: '/w/inner' })
    expect(projectAt('/w/inner/src')?.name).toBe('inner')
    expect(projectAt('/w/other')?.name).toBe('outer')
  })

  test('settings survive a round trip', () => {
    upsertProject({
      name: 'alpha',
      path: '/w/alpha',
      settings: { trunk: 'develop', states: { in_progress: 'active' } },
    })
    const p = projectAt('/w/alpha')!
    expect(p.settings.trunk).toBe('develop')
    expect(p.settings.states?.in_progress).toBe('active')
  })

  test('registration validates a tracked recipe at its project path', () => {
    projectDirectory = mkdtempSync(join(tmpdir(), 'orch-project-recipe-'))
    writeFileSync(join(projectDirectory, 'worktree.jsonc'), '{"create":[]}')
    expect(
      validateProjectSettings({ worktree: { recipePath: 'worktree.jsonc' } }, projectDirectory),
    ).toEqual([])
    writeFileSync(join(projectDirectory, 'worktree.jsonc'), '{"create":[],"unknown":true}')
    expect(
      validateProjectSettings(
        { worktree: { recipePath: 'worktree.jsonc' } },
        projectDirectory,
      ).join('\n'),
    ).toContain('unknown-key rule')
  })

  test('registration refuses simultaneous inline and tracked recipes', () => {
    expect(
      validateProjectSettings({
        worktree: { recipe: {}, recipePath: '.orch/worktree.jsonc' },
      }).join('\n'),
    ).toContain('recipe and recipePath may not both be declared')
  })
})
