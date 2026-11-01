import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS } from './check-plan.ts'
import {
  classifyWorkerOmissionEvidence,
  staticCheckPlan,
  workerBiomeFiles,
  workerCheckProjection,
} from './static-check-plan.ts'

const STATIC_CHECKS = staticCheckPlan()
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('worker static check plan', () => {
  test('combines committed, working-tree, and untracked paths once in stable order', () => {
    const files = workerBiomeFiles({
      nameStatus:
        'M\0scripts/committed.ts\0M\0scripts/working-tree.ts\0M\0scripts/shared.ts\0D\0scripts/deleted.ts\0R100\0scripts/old.ts\0scripts/renamed.ts\0M\0scripts/naïve.ts\0',
      untracked: 'scripts/untracked.ts\0scripts/shared.ts\0',
    })

    expect(files).toEqual([
      'scripts/committed.ts',
      'scripts/naïve.ts',
      'scripts/renamed.ts',
      'scripts/shared.ts',
      'scripts/untracked.ts',
      'scripts/working-tree.ts',
    ])
  })

  test('returns no Biome files for empty Git output', () => {
    expect(workerBiomeFiles({ nameStatus: '', untracked: '' })).toEqual([])
  })

  test('builds worker Biome argv from the selected files without changed mode', () => {
    const files = ['scripts/committed.ts', 'scripts/untracked.ts']
    const projection = workerCheckProjection(STATIC_CHECKS, CHECK_LEGS, [])

    const argv = projection.biome.workerArgv!({ root: '/repo/', files })

    expect(argv).toEqual([
      '/repo/node_modules/.bin/biome',
      'ci',
      '--no-errors-on-unmatched',
      ...files,
    ])
    expect(argv).not.toContain('--changed')
  })

  test.each([
    ['run 25620', 'run'],
    ['"bun run check"', 'command'],
    ['shared/store-access.ts:decideStoreAccess', 'citation'],
    ['', 'invalid'],
    ['needs a database', 'invalid'],
    ['DEV-1949', 'invalid'],
  ] as const)('classifies omission evidence %s as %s', (evidence, kind) => {
    expect(classifyWorkerOmissionEvidence(evidence).kind).toBe(kind)
  })

  test('requires valid, resolvable evidence for every worker omission', () => {
    expect(STATIC_CHECKS.length).toBeGreaterThan(0)
    const omissions = [
      ...STATIC_CHECKS.flatMap((check) => (check.worker.run ? [] : [check.worker])),
      ...CHECK_LEGS.flatMap((leg) => (leg.worker.run ? [] : [leg.worker])),
    ]
    expect(omissions.length).toBeGreaterThan(0)

    for (const omission of omissions) {
      if ('subjects' in omission && omission.subjects !== undefined) {
        for (const subject of omission.subjects) {
          const subjectPath = join(REPOSITORY_ROOT, subject)
          expect(existsSync(subjectPath), `${subject} must exist`).toBe(true)
          expect(statSync(subjectPath).isDirectory(), `${subject} must be a directory`).toBe(true)
        }
      }

      const evidence = classifyWorkerOmissionEvidence(omission.evidence)
      expect(evidence.kind, omission.evidence).not.toBe('invalid')
      if (evidence.kind !== 'citation') continue

      const citedPath = join(REPOSITORY_ROOT, evidence.path)
      expect(existsSync(citedPath), `${evidence.path} must exist`).toBe(true)
      const declaration = new RegExp(
        `\\b(?:function|const|class|type|interface)\\s+${evidence.symbol.replaceAll('$', '\\$')}\\b`,
      )
      expect(
        readFileSync(citedPath, 'utf8'),
        `${omission.evidence} must name a declaration`,
      ).toMatch(declaration)
    }
  })

  test('includes the checks that protect worker changes from known silent failures', () => {
    const projection = workerCheckProjection(STATIC_CHECKS, CHECK_LEGS, [])
    const run = new Set<string>([
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
      'scripts/check-gitleaks.ts',
      'scripts/check-machine-state.ts',
      'scripts/check-launchd-templates.ts',
      'scripts/check-hook-binary.ts',
      'orchestrator/scripts/check-canon-lint.ts',
      'scripts/quality/check-test-substance.ts',
    ]) {
      expect(run.has(name), `${name} must run in worker mode`).toBe(true)
    }

    const typecheckLegs = new Set<string>(projection.typecheckLegs.map((leg) => leg.name))
    for (const name of ['cli', 'orchestrator', 'hub']) {
      expect(typecheckLegs.has(name), `${name} typecheck must run in worker mode`).toBe(true)
    }
  })

  test('reports every projected omission without also running it', () => {
    const projection = workerCheckProjection(STATIC_CHECKS, CHECK_LEGS, [])
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

  test('forces hosted migration checks for a changed hosted migration', () => {
    const file = 'shared/record/migrations/0190_x/migration.sql'
    const projection = workerCheckProjection(STATIC_CHECKS, CHECK_LEGS, [file])
    const expected = [
      'hosted SQL schema',
      'scripts/check-postgres-migrations.ts',
      'scripts/check-record-migrations-apply.ts',
    ]

    expect(projection.staticChecks.map((check) => check.name)).toEqual(
      expect.arrayContaining(expected),
    )
    expect(projection.forced).toEqual(
      expected.map((name) => ({ name, subject: 'shared/record/migrations/', file })),
    )
    const omittedNames = projection.omitted.map((omission) => omission.name)
    for (const name of expected) expect(omittedNames).not.toContain(name)
  })

  test('forces only cascade preservation for a changed orchestrator migration', () => {
    const file = 'orchestrator/migrations/0190_x.sql'
    const projection = workerCheckProjection(STATIC_CHECKS, CHECK_LEGS, [file])

    expect(projection.forced).toEqual([
      { name: 'scripts/check-cascade-preservation.ts', subject: 'orchestrator/migrations/', file },
    ])
  })

  test('leaves every omission omitted for an ordinary source change', () => {
    const projection = workerCheckProjection(STATIC_CHECKS, CHECK_LEGS, ['orchestrator/src/x.ts'])
    const unchanged = workerCheckProjection(STATIC_CHECKS, CHECK_LEGS, [])

    expect(projection.forced).toEqual([])
    expect(projection.omitted).toEqual(unchanged.omitted)
    expect(projection.staticChecks).toEqual(unchanged.staticChecks)
  })

  test('does not match a path that only shares the subject prefix text', () => {
    const projection = workerCheckProjection(STATIC_CHECKS, CHECK_LEGS, [
      'shared/record/migrations-old/x',
    ])

    expect(projection.forced).toEqual([])
  })
})
