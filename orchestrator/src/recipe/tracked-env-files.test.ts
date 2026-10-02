import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrackedRecipe } from './recipe-schema.ts'
import { recipeSchema } from './recipe-schema.ts'
import { stepCommandPlan } from './recipe-step.ts'
import { databaseUrlSecrets, writeTrackedEnvFiles } from './tracked-env-files.ts'
import { trackedRecipeVars } from './tracked-recipe.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryTree(): { project: string; tree: string } {
  const project = mkdtempSync(join(tmpdir(), 'orch-db-url-project-'))
  const tree = join(project, 'tree-name')
  mkdirSync(tree)
  directories.push(project)
  return { project, tree }
}

function writeEnv(
  recipe: TrackedRecipe,
  tree: string,
  project: string,
  allocations: Record<string, string>,
) {
  const urls = databaseUrlSecrets(recipe, allocations, project)
  if (!urls.ok) return urls.result
  return writeTrackedEnvFiles(
    recipe,
    {
      treeRoot: tree,
      vars: trackedRecipeVars({}, { index: 4, ports: {}, databases: allocations, strings: {} }, 1),
    },
    project,
    urls.secrets,
  )
}

const provisioned = {
  allocate: {
    databases: {
      app: {
        engine: 'postgres' as const,
        name: 'app_{index}',
        provision: { from: 'base', connection: { key: 'DATABASE_URL' } },
      },
    },
  },
  create: [] as { name: string; run: { command: string; args: string[] } }[],
}

describe('tracked recipe database URL env placeholders', () => {
  test('writes the allocated database name into the connection URL and keeps the credentials', () => {
    const { project, tree } = temporaryTree()
    writeFileSync(
      join(project, '.env'),
      'DATABASE_URL=postgres://admin:super-secret@db.local:5432/base?sslmode=require\n',
    )
    const recipe = recipeSchema.parse({
      ...provisioned,
      env: [{ path: '.env', mode: 'replace', contents: 'DATABASE_URL={db.app.url}\n' }],
    })
    const allocations = { app: 'tree_app_4' }
    expect(writeEnv(recipe, tree, project, allocations)).toBeNull()
    expect(readFileSync(join(tree, '.env'), 'utf8')).toBe(
      'DATABASE_URL=postgres://admin:super-secret@db.local:5432/tree_app_4?sslmode=require\n',
    )
  })

  test('a step argument using {db.app.url} is refused as an unavailable placeholder', () => {
    const vars = trackedRecipeVars(
      {},
      { index: 4, ports: {}, databases: { app: 'tree_app_4' }, strings: {} },
      1,
    )
    expect(vars['db.app.url']).toBeUndefined()
    expect(
      stepCommandPlan(
        { command: 'psql', args: ['{db.app.url}'] },
        undefined,
        { treeRoot: '/tree', vars },
        'migrate',
        'run',
      ),
    ).toEqual({
      ok: false,
      reason: 'unavailable placeholder {db.app.url} in migrate.run',
    })
  })

  test('a missing connection key refuses env writing without the password or URL', () => {
    const { project, tree } = temporaryTree()
    writeFileSync(join(project, '.env'), 'OTHER=postgres://admin:super-secret@db.local/base\n')
    const recipe = recipeSchema.parse({
      ...provisioned,
      env: [{ path: '.env', mode: 'replace', contents: 'DATABASE_URL={db.app.url}\n' }],
    })
    const failure = writeEnv(recipe, tree, project, { app: 'tree_app_4' })
    expect(failure?.detail).toContain('.env')
    expect(failure?.detail).toContain('app')
    expect(failure?.detail).toContain('DATABASE_URL')
    expect(failure?.detail).not.toContain('super-secret')
    expect(failure?.detail).not.toContain('postgres://')
    expect(existsSync(join(tree, '.env'))).toBeFalse()
  })
})
