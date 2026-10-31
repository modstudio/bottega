import { describe, expect, test } from 'bun:test'
import { CHECK_LEGS } from './check-plan.ts'
import { staticCheckPlan, workerBiomeFiles, workerCheckProjection } from './static-check-plan.ts'

const STATIC_CHECKS = staticCheckPlan()

describe('worker static check plan', () => {
  test('combines committed, working-tree, and untracked paths once in stable order', () => {
    const files = workerBiomeFiles({
      changedSinceBase: 'scripts/committed.ts\nscripts/working-tree.ts\n\nscripts/shared.ts\n',
      untracked: 'scripts/untracked.ts\nscripts/shared.ts\n\n',
    })

    expect(files).toEqual([
      'scripts/committed.ts',
      'scripts/shared.ts',
      'scripts/untracked.ts',
      'scripts/working-tree.ts',
    ])
  })

  test('returns no Biome files for empty Git output', () => {
    expect(workerBiomeFiles({ changedSinceBase: '', untracked: '' })).toEqual([])
  })

  test('builds worker Biome argv from the selected files without changed mode', () => {
    const files = ['scripts/committed.ts', 'scripts/untracked.ts']
    const projection = workerCheckProjection(STATIC_CHECKS, CHECK_LEGS)

    const argv = projection.biome.workerArgv!({ root: '/repo/', files })

    expect(argv).toEqual([
      '/repo/node_modules/.bin/biome',
      'ci',
      '--no-errors-on-unmatched',
      ...files,
    ])
    expect(argv).not.toContain('--changed')
  })

  test('gives every omission a non-empty reason', () => {
    expect(STATIC_CHECKS.length).toBeGreaterThan(0)
    for (const check of STATIC_CHECKS) {
      if (!check.worker.run) expect(check.worker.reason.trim()).not.toBe('')
    }
  })

  test('includes the checks that protect worker changes from known silent failures', () => {
    const projection = workerCheckProjection(STATIC_CHECKS, CHECK_LEGS)
    const run = new Set([
      projection.biome.name,
      ...projection.staticChecks.map((check) => check.name),
    ])
    for (const name of [
      'Biome',
      'scripts/check-architecture.ts',
      'scripts/check-file-ceiling.ts',
      'scripts/check-cognitive-ceiling.ts',
      'scripts/check-test-placement.ts',
      'scripts/check-dead-code.ts',
      'scripts/check-brand.ts',
      'scripts/check-legacy-names.ts',
      'orchestrator/scripts/check-canon-lint.ts',
      'scripts/quality/check-test-substance.ts',
    ]) {
      expect(run.has(name), `${name} must run in worker mode`).toBe(true)
    }

    const typecheckLegs = new Set(projection.typecheckLegs.map((leg) => leg.name))
    for (const name of ['cli', 'orchestrator', 'hub']) {
      expect(typecheckLegs.has(name), `${name} typecheck must run in worker mode`).toBe(true)
    }
  })

  test('reports every projected omission without also running it', () => {
    const projection = workerCheckProjection(STATIC_CHECKS, CHECK_LEGS)
    expect(projection.omitted).toContainEqual({
      name: 'test suites',
      reason: 'worker check runs no test suites; bun run check runs them',
    })
    for (const omission of projection.omitted) expect(omission.reason.trim()).not.toBe('')

    const header = `worker check omitted ${projection.omitted.length} steps; bun run check runs them all`
    expect(Number(header.match(/omitted (\d+) steps/)?.[1])).toBe(projection.omitted.length)

    const run = new Set([
      projection.biome.name,
      ...projection.typecheckLegs.map((leg) => `${leg.name} typecheck`),
      ...projection.staticChecks.map((check) => check.name),
    ])
    for (const omission of projection.omitted) expect(run.has(omission.name)).toBe(false)
  })
})
