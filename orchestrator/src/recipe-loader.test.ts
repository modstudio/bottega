import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTrackedRecipe } from './recipe-loader.ts'

let directory: string | null = null

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = null
})

function projectDirectory(): string {
  directory = mkdtempSync(join(tmpdir(), 'orch-recipe-loader-'))
  return directory
}

describe('tracked recipe loading', () => {
  test('accepts JSONC comments and trailing commas', () => {
    const project = projectDirectory()
    writeFileSync(
      join(project, 'recipe.jsonc'),
      '{ // the step name is stable\n "worktree": {"create": [{"name":"create","run":{"command":"true","args":[],},}],},\n}',
    )
    const loaded = loadTrackedRecipe(project, 'recipe.jsonc')
    expect(loaded.ok).toBe(true)
    if (loaded.ok) expect(loaded.recipe?.create[0]?.name).toBe('create')
  })

  test('returns the resolved path when the file is missing', () => {
    const project = projectDirectory()
    const loaded = loadTrackedRecipe(project, 'missing.jsonc')
    expect(loaded).toEqual({
      ok: false,
      errors: [expect.stringContaining(join(project, 'missing.jsonc'))],
    })
  })

  test('returns the path and parse refusal for malformed JSONC', () => {
    const project = projectDirectory()
    writeFileSync(join(project, 'broken.jsonc'), '{ "create": [ }')
    const loaded = loadTrackedRecipe(project, 'broken.jsonc')
    expect(loaded).toEqual({
      ok: false,
      errors: [
        expect.stringContaining(
          `tracked recipe ${join(project, 'broken.jsonc')} could not be parsed as JSONC`,
        ),
      ],
    })
  })

  test('refuses absolute and parent-traversing pointers before reading', () => {
    const project = projectDirectory()
    for (const pointer of ['/tmp/recipe.jsonc', '../recipe.jsonc']) {
      const loaded = loadTrackedRecipe(project, pointer)
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) expect(loaded.errors.join('\n')).toContain('recipe path rule')
    }
  })

  test('reports strict validation errors with their rule and path', () => {
    const project = projectDirectory()
    writeFileSync(join(project, 'recipe.jsonc'), '{"worktree":{"create":[]},"mystery":true}')
    const loaded = loadTrackedRecipe(project, 'recipe.jsonc')
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) {
      expect(loaded.errors.join('\n')).toContain('unknown-key rule')
      expect(loaded.errors.join('\n')).toContain(join(project, 'recipe.jsonc'))
    }
  })

  test('accepts a root schema and no worktree as no lifecycle', () => {
    const project = projectDirectory()
    writeFileSync(join(project, 'recipe.jsonc'), '{"$schema":"schema.json"}')
    expect(loadTrackedRecipe(project, 'recipe.jsonc')).toEqual({ ok: true, recipe: null })
  })

  test('refuses a schema declaration inside worktree', () => {
    const project = projectDirectory()
    writeFileSync(
      join(project, 'recipe.jsonc'),
      '{"worktree":{"$schema":"schema.json","create":[]}}',
    )
    const loaded = loadTrackedRecipe(project, 'recipe.jsonc')
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.errors.join('\n')).toContain('unknown-key rule')
  })
})
