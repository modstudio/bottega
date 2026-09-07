import { describe, expect, test } from 'bun:test'
import { db } from '../test/fixture.ts'
import {
  dockerInventoryTimeoutForSize,
  elapsedAssertionMs,
  elapsedLockTimeoutMs,
  failingTests,
  namedFailureSignal,
  recordTestFlake,
  runWithRetry,
  shardTimeoutMs,
  timeoutMsForSize,
  weeklyFlakeCount,
  exclusiveShareViolations,
  parseShardMap,
  type FilePolicy,
} from './gate-policy.ts'

describe('test size classes', () => {
  test('a size-class change moves a bound', () => {
    const files: Record<string, FilePolicy> = { 'src/a.cli.test.ts': { size: 'short' } }
    expect(timeoutMsForSize('short')).toBe(30_000)
    expect(timeoutMsForSize('moderate')).toBe(120_000)
    expect(timeoutMsForSize('long')).toBe(600_000)
    expect(shardTimeoutMs(files, ['src/a.cli.test.ts'])).toBe(30_000)
    expect(dockerInventoryTimeoutForSize(files['src/a.cli.test.ts']!.size)).toBe(1_000)
    expect(elapsedAssertionMs(files['src/a.cli.test.ts']!.size)).toBe(50)
    expect(elapsedLockTimeoutMs('short')).toBe(250)
    files['src/a.cli.test.ts'] = { size: 'moderate' }
    expect(shardTimeoutMs(files, ['src/a.cli.test.ts'])).toBe(120_000)
    expect(dockerInventoryTimeoutForSize('moderate')).toBe(4_000)
    expect(elapsedAssertionMs('moderate')).toBe(200)
    expect(elapsedLockTimeoutMs('moderate')).toBe(1_000)
    expect(dockerInventoryTimeoutForSize('long')).toBe(20_000)
    expect(elapsedAssertionMs('long')).toBe(1_000)
  })

  test('parseShardMap names the file and the invalid entry', () => {
    const source = 'test/shards.json'
    expect(() => parseShardMap({
      files: { 'src/a.cli.test.ts': { size: 'huge' } },
      shards: [{ files: ['src/a.cli.test.ts'] }],
    }, source)).toThrow(`${source}: src/a.cli.test.ts has invalid size "huge"`)
    expect(() => parseShardMap({
      files: { 'src/a.cli.test.ts': { size: 'short', exclusive: 'yes' } },
      shards: [{ files: ['src/a.cli.test.ts'] }],
    }, source)).toThrow(`${source}: src/a.cli.test.ts has invalid exclusive "yes"`)
    expect(() => parseShardMap({
      files: { 'src/a.cli.test.ts': { size: 'short' } },
      shards: [{ files: ['src/missing.cli.test.ts'] }],
    }, source)).toThrow(`${source}: src/missing.cli.test.ts is missing from files`)
    expect(parseShardMap({
      files: { 'src/a.cli.test.ts': { size: 'short', exclusive: true } },
      shards: [{ files: ['src/a.cli.test.ts'] }],
    }, source)).toEqual({
      files: { 'src/a.cli.test.ts': { size: 'short', exclusive: true } },
      shards: [{ files: ['src/a.cli.test.ts'] }],
    })
  })

  test('exclusive files never share a shard', () => {
    expect(exclusiveShareViolations({
      files: {
        'src/landing-1.cli.test.ts': { size: 'short', exclusive: true },
        'src/docs.cli.test.ts': { size: 'short' },
        'src/landing-2.cli.test.ts': { size: 'short', exclusive: true },
      },
      shards: [
        { files: ['src/landing-1.cli.test.ts', 'src/docs.cli.test.ts'] },
        { files: ['src/landing-2.cli.test.ts'] },
      ],
    })).toEqual([])
    expect(exclusiveShareViolations({
      files: {
        'src/landing-1.cli.test.ts': { size: 'short', exclusive: true },
        'src/landing-2.cli.test.ts': { size: 'short', exclusive: true },
      },
      shards: [{ files: ['src/landing-1.cli.test.ts', 'src/landing-2.cli.test.ts'] }],
    })).toEqual([['src/landing-1.cli.test.ts', 'src/landing-2.cli.test.ts']])
  })
})

describe('named-signal retry', () => {
  test('a named-signal failure retries once and records FLAKY', async () => {
    const calls = { n: 0 }
    const flakes: { test: string; file: string; signal: string }[] = []
    const result = await runWithRetry({
      name: 'shard 1',
      files: ['src/a.cli.test.ts'],
      run: async () => {
        calls.n++
        if (calls.n === 1) {
          return {
            exitCode: 143,
            output: 'src/a.cli.test.ts:\n(fail) landing binds confinement\nerror: killed\n',
          }
        }
        return { exitCode: 0, output: 'ok' }
      },
      weeklyCount: () => 0,
      recordFlake: (row) => flakes.push(row),
    })
    expect(calls.n).toBe(2)
    expect(result.exitCode).toBe(0)
    expect(result.flaky).toBe(true)
    expect(flakes).toEqual([{
      file: 'src/a.cli.test.ts', test: 'landing binds confinement', signal: 'exit-143',
    }])
  })

  test('an unnamed failure does not retry', async () => {
    const calls = { n: 0 }
    const flakes: unknown[] = []
    const result = await runWithRetry({
      name: 'shard 1',
      files: ['src/a.cli.test.ts'],
      run: async () => {
        calls.n++
        return {
          exitCode: 1,
          output: 'src/a.cli.test.ts:\n(fail) assertion\nerror: expect(received).toBe(expected)\n',
        }
      },
      weeklyCount: () => 0,
      recordFlake: (row) => flakes.push(row),
    })
    expect(calls.n).toBe(1)
    expect(result.exitCode).toBe(1)
    expect(result.flaky).toBeUndefined()
    expect(flakes).toEqual([])
  })

  test('two flakes of one test in a week are printed as a question and not retried', async () => {
    const calls = { n: 0 }
    const result = await runWithRetry({
      name: 'shard 1',
      files: ['src/a.cli.test.ts'],
      run: async () => {
        calls.n++
        return {
          exitCode: 143,
          output: 'src/a.cli.test.ts:\n(fail) landing binds confinement\n',
        }
      },
      weeklyCount: () => 2,
      recordFlake: () => { throw new Error('must not record') },
    })
    expect(calls.n).toBe(1)
    expect(result.exitCode).toBe(143)
    expect(result.question).toContain('QUESTION:')
    expect(result.question).toContain('landing binds confinement')
    expect(result.question).toContain('flaked twice this week')
  })

  test('timeout, lock wait and listen EPERM are named signals', () => {
    expect(namedFailureSignal(1, 'error: this test timed out after 30000ms')).toBe('timeout')
    expect(namedFailureSignal(1, 'timed out waiting for this project\'s landing lock')).toBe('lock-wait')
    expect(namedFailureSignal(1, 'listen 127.0.0.1:0 EPERM')).toBe('listen-eperm')
    expect(namedFailureSignal(1, 'expect(received).toBe(expected)')).toBeNull()
    expect(failingTests('[shard 1] src/a.cli.test.ts:\n[shard 1] (fail) suite > name\n'))
      .toEqual([{ file: 'src/a.cli.test.ts', test: 'suite > name' }])
  })

  test('a recorded flake increments the week count on the fixture store', () => {
    const now = new Date('2026-09-07T12:00:00.000Z')
    expect(weeklyFlakeCount(db(), 'landing binds confinement', 'src/a.cli.test.ts', now)).toBe(0)
    recordTestFlake(db(), {
      test: 'landing binds confinement',
      file: 'src/a.cli.test.ts',
      load: { gates: 3, loadavg: 4.2, ncpu: 8, freeMem: 2_000_000_000 },
      at: '2026-09-07T11:00:00.000Z',
    })
    expect(weeklyFlakeCount(db(), 'landing binds confinement', 'src/a.cli.test.ts', now)).toBe(1)
  })
})
