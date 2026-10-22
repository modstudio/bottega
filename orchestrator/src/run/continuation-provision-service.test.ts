import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Project } from '../project/projects.ts'
import {
  continuationProvisionRefusal,
  requireContinuationProvision,
} from './continuation-provision-service.ts'

const seededProject = {
  recordId: 'project-seeded',
  name: 'seeded',
  path: '/projects/seeded-without-recipe',
  stack: null,
  canon: false,
  retiredAt: null,
  settings: { worktree: { seeds: ['minimal'] } },
} satisfies Project

describe('continuation provision refusal', () => {
  test('names the missing recorded seed and the command that clears it', () => {
    const seedRefusal =
      'this project requires a database size for a new worktree, and has no default.\n' +
      '  --seed minimal'
    expect(continuationProvisionRefusal('01a163e6-2cf2-714f-a420-364800cb5f77', seedRefusal)).toBe(
      `run 01a163e6-2cf2-714f-a420-364800cb5f77 cannot be continued: it must recreate its worktree and has no recorded launch seed\n` +
        `${seedRefusal}\n` +
        `cleared by: ${PLATFORM_SLUG} run start --seed <value>`,
    )
  })
})

describe('continuation provision requirement', () => {
  test('reuses an intact tree without requiring a seed', () => {
    expect(
      requireContinuationProvision({
        rootId: 'run-1',
        reuseIntactTree: true,
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
        reuseIntactTree: false,
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
        reuseIntactTree: false,
        recordedSeed: undefined,
        writesRepo: true,
        project: seededProject,
      }),
    ).toThrow(/no recorded launch seed[\s\S]*cleared by: .* run start --seed <value>/)
  })
})
