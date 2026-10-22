import { describe, expect, test } from 'bun:test'
import type { Project } from '../project/projects.ts'
import { requireContinuationProvision } from './continuation-provision-service.ts'

const seededProject = {
  recordId: 'project-seeded',
  name: 'seeded',
  path: '/projects/seeded-without-recipe',
  stack: null,
  canon: false,
  retiredAt: null,
  settings: { worktree: { seeds: ['minimal'] } },
} satisfies Project

describe('continuation provision requirement', () => {
  test('reuses an intact tree without requiring a seed', () => {
    expect(
      requireContinuationProvision({
        rootId: 'run-1',
        treeDecision: { action: 'inherit-present-tree' },
        recordedSeed: undefined,
        writesRepo: true,
        project: seededProject,
      }),
    ).toEqual({ seed: undefined })
  })

  test('recreates with the recorded seed', () => {
    expect(
      requireContinuationProvision({
        rootId: 'run-1',
        treeDecision: { action: 'recreate-writer-tree' },
        recordedSeed: 'minimal',
        writesRepo: true,
        project: seededProject,
      }),
    ).toEqual({ seed: 'minimal' })
  })

  test('refuses a recreated tree whose recorded seed is missing where the project requires one', () => {
    expect(() =>
      requireContinuationProvision({
        rootId: 'run-1',
        treeDecision: { action: 'recreate-writer-tree' },
        recordedSeed: undefined,
        writesRepo: true,
        project: seededProject,
      }),
    ).toThrow(
      /no recorded launch seed[\s\S]*requires a database size[\s\S]*--seed minimal[\s\S]*cleared by: .* run start --seed <value>/,
    )
  })
})
