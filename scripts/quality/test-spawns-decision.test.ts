import { expect, test } from 'bun:test'
import {
  decideSpawnRule,
  loweredSpawnBaseline,
  type SpawnBaseline,
  shardOfCommand,
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

test('the regenerate step drops a measured baselined file at or below the limit', () => {
  expect(
    loweredSpawnBaseline({
      measurements: [
        { file: 'orchestrator/src/at-limit.test.ts', spawns: 20 },
        { file: 'orchestrator/src/below.test.ts', spawns: 4 },
      ],
      baseline: {
        files: { 'orchestrator/src/at-limit.test.ts': 22, 'orchestrator/src/below.test.ts': 24 },
      },
    }),
  ).toEqual({ files: {} })
})

test('the regenerate step keeps a baselined file the measurement never mentioned', () => {
  expect(
    loweredSpawnBaseline({
      measurements: [{ file: 'orchestrator/src/measured.test.ts', spawns: 25 }],
      baseline: {
        files: {
          'orchestrator/src/measured.test.ts': 30,
          'orchestrator/src/absent.test.ts': 41,
        },
      },
    }),
  ).toEqual({
    files: {
      'orchestrator/src/absent.test.ts': 41,
      'orchestrator/src/measured.test.ts': 25,
    },
  })
})

test('a shard in the recorded command is reported', () => {
  expect(shardOfCommand(['bun', 'test', 'src', '--shard=2/4'])).toBe('2/4')
})

test('an unsharded or commandless artifact reports no shard', () => {
  expect(shardOfCommand(['bun', 'test', 'src'])).toBeNull()
  expect(shardOfCommand(undefined)).toBeNull()
  expect(shardOfCommand(null)).toBeNull()
})
