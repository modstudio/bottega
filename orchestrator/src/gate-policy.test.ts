import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from './db.ts'
import {
  DOCKER_INVENTORY_TIMEOUT_BY_SIZE,
  ELAPSED_ASSERTION_MS,
  TIMEOUT_MS,
  dockerInventoryTimeoutForSize,
  elapsedAssertionMs,
  elapsedLockTimeoutMs,
  failingTests,
  formatFlakyLine,
  flakeCommand,
  mainCheckoutFlakeStore,
  namedFailureSignal,
  recordTestFlake,
  runWithRetry,
  shardTimeoutMs,
  timeoutMsForSize,
  weeklyFlakeCount,
  exclusiveShareViolations,
  parseShardMap,
  type FilePolicy,
  type HostLoad,
} from './gate-policy.ts'

const load: HostLoad = { gates: 2, loadavg: 1.5, ncpu: 8, freeMem: 1_000_000 }

describe('flake command', () => {
  test('record writes a row which count reads', () => {
    expect(flakeCommand([
      'record', 'flake command test', 'src/flake.test.ts', 'timeout', '--load', JSON.stringify(load),
    ], db())).toBe('recorded flake flake command test (src/flake.test.ts)')
    expect(flakeCommand(['count', 'flake command test', 'src/flake.test.ts'], db())).toBe('1')
  })

  test('malformed requests name the problem and both working forms', () => {
    const failures = [
      { argv: ['record', 'test', 'file', 'unknown', '--load', JSON.stringify(load)], problem: 'invalid flake signal' },
      { argv: ['record', 'test', 'file', 'timeout', '--load', '{'], problem: 'invalid flake load JSON' },
      { argv: ['record', 'test'], problem: 'missing or invalid flake record argument' },
      { argv: ['remove'], problem: 'unknown flake subcommand' },
    ]
    for (const failure of failures) {
      expect(() => flakeCommand(failure.argv, db())).toThrow(failure.problem)
      expect(() => flakeCommand(failure.argv, db())).toThrow('orch flake record')
      expect(() => flakeCommand(failure.argv, db())).toThrow('orch flake count')
    }
  })
})

describe('main checkout flake store', () => {
  test('count and record invoke the main checkout binary', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-flake-main-'))
    const linked = `${repo}-linked`
    try {
      for (const argv of [
        ['git', 'init', '-b', 'main'],
        ['git', 'config', 'user.email', 'orch-test@example.invalid'],
        ['git', 'config', 'user.name', 'Orch Test'],
        ['git', 'commit', '--allow-empty', '-m', 'fixture'],
        ['git', 'worktree', 'add', '-b', 'linked', linked],
      ]) {
        const result = Bun.spawnSync(argv, { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
        if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      }
      const calls: string[][] = []
      const run = (argv: string[]) => {
        calls.push(argv)
        return { exitCode: 0, stdout: argv[2] === 'count' ? '3\n' : '', stderr: '' }
      }
      const store = mainCheckoutFlakeStore(linked, run)
      const binary = join(realpathSync(repo), 'bin', 'orch')
      expect(store.count('a test', 'src/a.test.ts')).toBe(3)
      store.record({ test: 'a test', file: 'src/a.test.ts', signal: 'timeout', load })
      expect(calls).toEqual([
        [binary, 'flake', 'count', 'a test', 'src/a.test.ts'],
        [binary, 'flake', 'record', 'a test', 'src/a.test.ts', 'timeout', '--load', JSON.stringify(load)],
      ])
    } finally {
      rmSync(linked, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('failed and non-integer counts return zero and log the binary; failed records log', () => {
    const logs: string[] = []
    const results = [
      { exitCode: 1, stdout: '', stderr: 'count broke' },
      { exitCode: 0, stdout: 'not a number', stderr: '' },
      { exitCode: 1, stdout: '', stderr: 'record broke' },
    ]
    const store = mainCheckoutFlakeStore(process.cwd(), () => results.shift()!, (line) => logs.push(line))
    expect(store.count('test', 'file')).toBe(0)
    expect(store.count('test', 'file')).toBe(0)
    store.record({ test: 'test', file: 'file', signal: 'lock-wait', load })
    expect(logs).toHaveLength(3)
    expect(logs.every((line) => line.includes(join('bin', 'orch')))).toBe(true)
    expect(logs[0]).toContain('count broke')
    expect(logs[1]).toContain('non-integer')
    expect(logs[2]).toContain('record broke')
  })
})

describe('test size classes', () => {
  test('a size-class change moves a bound', () => {
    const files: Record<string, FilePolicy> = { 'src/a.cli.test.ts': { size: 'short' } }
    expect(timeoutMsForSize('short')).toBe(TIMEOUT_MS.short)
    expect(timeoutMsForSize('moderate')).toBe(TIMEOUT_MS.moderate)
    expect(timeoutMsForSize('long')).toBe(TIMEOUT_MS.long)
    expect(shardTimeoutMs(files, ['src/a.cli.test.ts'])).toBe(TIMEOUT_MS.short)
    expect(dockerInventoryTimeoutForSize(files['src/a.cli.test.ts']!.size))
      .toBe(DOCKER_INVENTORY_TIMEOUT_BY_SIZE.short)
    expect(elapsedAssertionMs(files['src/a.cli.test.ts']!.size)).toBe(ELAPSED_ASSERTION_MS.short)
    expect(elapsedLockTimeoutMs('short')).toBe(ELAPSED_ASSERTION_MS.short * 5)
    files['src/a.cli.test.ts'] = { size: 'moderate' }
    expect(shardTimeoutMs(files, ['src/a.cli.test.ts'])).toBe(TIMEOUT_MS.moderate)
    expect(dockerInventoryTimeoutForSize('moderate')).toBe(DOCKER_INVENTORY_TIMEOUT_BY_SIZE.moderate)
    expect(elapsedAssertionMs('moderate')).toBe(ELAPSED_ASSERTION_MS.moderate)
    expect(elapsedLockTimeoutMs('moderate')).toBe(ELAPSED_ASSERTION_MS.moderate * 5)
    expect(dockerInventoryTimeoutForSize('long')).toBe(DOCKER_INVENTORY_TIMEOUT_BY_SIZE.long)
    expect(elapsedAssertionMs('long')).toBe(ELAPSED_ASSERTION_MS.long)
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
    expect(result.flakyLine).toBe(formatFlakyLine('shard 1'))
    expect(result.flakyLine).toBe('FLAKY shard 1 passed after a named-signal failure')
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
    expect(result.flakyLine).toBeUndefined()
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
      load: {
        gates: 3, loadavg: 4.2, ncpu: 8, freeMem: 2_000_000_000,
        elapsedMs: 92, boundMs: 50,
      } as HostLoad,
      signal: 'exit-143',
      at: '2026-09-07T11:00:00.000Z',
    })
    expect(weeklyFlakeCount(db(), 'landing binds confinement', 'src/a.cli.test.ts', now)).toBe(1)
    const stored = db().query(`SELECT load_at_failure, signal FROM test_flake`).get() as
      { load_at_failure: string; signal: string }
    expect(JSON.parse(stored.load_at_failure)).toEqual({
      gates: 3, loadavg: 4.2, ncpu: 8, freeMem: 2_000_000_000,
    })
    expect(stored.signal).toBe('exit-143')
  })
})
