import { describe, expect, test } from 'bun:test'
import { composeCommandPlan, composeProjectName } from './compose-provision-plan.ts'
import { recipeSchema } from './recipe-schema.ts'

const recipe = recipeSchema.parse({ compose: { files: ['compose.yaml'] }, create: [] })

describe('Compose provision planning', () => {
  test('derives a sanitized project carrying the attributable run token', () => {
    expect(composeProjectName('_My.Project', 42)).toBe('my-project-orch-42')
    expect(composeProjectName('---', 42)).toBe('orch-42')
  })

  test('refuses a derived project used by a registered main checkout', () => {
    expect(() =>
      composeCommandPlan({
        recipe,
        projectName: 'My Project',
        rootRunId: 42,
        mainComposeProjects: ['my-project-orch-42'],
      }),
    ).toThrow('registered main checkout')
  })

  test('plans files, env file, and default wait in Compose CLI order', () => {
    const planned = composeCommandPlan({
      recipe: recipeSchema.parse({
        compose: { files: ['compose.yaml', 'compose.dev.yaml'], envFile: '.env.compose' },
        create: [],
      }),
      projectName: 'app',
      rootRunId: 7,
      mainComposeProjects: [],
    })!
    expect(planned.up).toEqual([
      'docker',
      'compose',
      '-p',
      'app-orch-7',
      '-f',
      'compose.yaml',
      '-f',
      'compose.dev.yaml',
      '--env-file',
      '.env.compose',
      'up',
      '-d',
      '--wait',
    ])
  })
})
