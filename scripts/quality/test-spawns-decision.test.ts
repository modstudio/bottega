import { expect, test } from 'bun:test'
import {
  decideSpawnRule,
  loweredSpawnBaseline,
  type SpawnBaseline,
  spawnViolations,
} from './test-spawns-decision.ts'

const baseline: SpawnBaseline = { files: { 'orchestrator/src/heavy.test.ts': 30 } }

test('a new file above the limit fails', () => {
  expect(
    decideSpawnRule({
      measurements: [
        { file: 'orchestrator/src/heavy.test.ts', spawns: 30 },
        { file: 'orchestrator/src/new.test.ts', spawns: 21 },
      ],
      baseline,
    }),
  ).toEqual({
    status: 'fail',
    violations: [{ file: 'orchestrator/src/new.test.ts', spawns: 21, baseline: null }],
  })
})

test('a baselined file that grew fails', () => {
  expect(
    decideSpawnRule({
      measurements: [{ file: 'orchestrator/src/heavy.test.ts', spawns: 31 }],
      baseline,
    }),
  ).toEqual({
    status: 'fail',
    violations: [{ file: 'orchestrator/src/heavy.test.ts', spawns: 31, baseline: 30 }],
  })
})

test('a baselined file that shrank passes', () => {
  expect(
    decideSpawnRule({
      measurements: [{ file: 'orchestrator/src/heavy.test.ts', spawns: 25 }],
      baseline,
    }),
  ).toEqual({ status: 'pass', measuredFiles: 1 })
})

test('a measurement that is missing fails', () => {
  expect(decideSpawnRule({ measurements: null, baseline })).toEqual({ status: 'missing' })
})

test('an unbudgeted file at exactly the limit passes', () => {
  expect(
    spawnViolations({
      measurements: [{ file: 'orchestrator/src/edge.test.ts', spawns: 20 }],
      baseline,
    }),
  ).toEqual([])
})

test('the regenerate step lowers a shrunken entry and drops one at the limit', () => {
  expect(
    loweredSpawnBaseline({
      measurements: [
        { file: 'orchestrator/src/heavy.test.ts', spawns: 25 },
        { file: 'orchestrator/src/light.test.ts', spawns: 20 },
      ],
      baseline: {
        files: { 'orchestrator/src/heavy.test.ts': 30, 'orchestrator/src/light.test.ts': 22 },
      },
    }),
  ).toEqual({ files: { 'orchestrator/src/heavy.test.ts': 25 } })
})

test('the regenerate step refuses a file that grew', () => {
  expect(() =>
    loweredSpawnBaseline({
      measurements: [{ file: 'orchestrator/src/heavy.test.ts', spawns: 31 }],
      baseline,
    }),
  ).toThrow('recorded baseline 30')
})
