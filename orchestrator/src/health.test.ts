import { describe, expect, test } from 'bun:test'
import { addRun, db } from '../test/fixture.ts'
import { insertContention } from './contention.ts'
import { FAILURE_KINDS } from './failure.ts'
import { harnessHealth } from './health.ts'

describe('harness health', () => {
  test('enumerates zero rows, weights time, clusters errors and reports cleared, voided and landing refusals', () => {
    const now = new Date('2026-09-07T12:00:00.000Z')
    const interruptedA = addRun({ agent: 'grok', job: 'review-lens', status: 'failed', kind: 'interrupted', latency: 600_000, startedAt: '2026-09-06T10:00:00.000Z' })
    const interruptedB = addRun({ agent: 'grok', job: 'review-lens', status: 'failed', kind: 'interrupted', latency: 420_000, startedAt: '2026-09-07T10:00:00.000Z' })
    const escaped = addRun({ agent: 'codex', job: 'implement', status: 'ok', latency: 30_000, startedAt: '2026-09-05T10:00:00.000Z' })
    const oldEscaped = addRun({ agent: 'codex', job: 'implement', status: 'failed', kind: 'escaped', latency: 20_000, startedAt: '2026-08-20T10:00:00.000Z' })
    const harness = addRun({ agent: 'codex', job: 'implement', status: 'failed', kind: 'harness', latency: 15_000, startedAt: '2026-09-05T11:00:00.000Z' })
    addRun({ agent: 'codex', job: 'implement', status: 'stale', latency: 5_000, startedAt: '2026-09-04T10:00:00.000Z' })
    db().query('UPDATE run SET error=? WHERE id IN (?,?)').run('exit 143, empty output', interruptedA, interruptedB)
    db().query(`INSERT INTO run_mutation_audit (run_id,root_id,action,actor_session,at,reason) VALUES (?,?,?,?,?,?)`)
      .run(escaped, escaped, 'reclassify', 'architect', '2026-09-08T12:00:00.000Z', JSON.stringify({ cleared: true }))
    db().query(`INSERT INTO run_mutation_audit (run_id,root_id,action,actor_session,at,reason) VALUES (?,?,?,?,?,?)`)
      .run(oldEscaped, oldEscaped, 'reclassify', 'architect', '2026-09-06T12:00:00.000Z', JSON.stringify({ cleared: true }))
    db().query(`INSERT INTO run_mutation_audit (run_id,root_id,action,actor_session,at,reason) VALUES (?,?,?,?,?,?)`)
      .run(harness, harness, 'void', 'architect', '2026-09-06T12:00:00.000Z', null)
    db().query(`INSERT INTO landing (project,branch,status,started_at,finished_at) VALUES ('fixture','DEV-350','refused',?,?)`)
      .run('2026-09-06T13:00:00.000Z', '2026-09-06T13:01:00.000Z')

    const report = harnessHealth(14, db(), now)
    expect(report.classes.map((row) => row.kind)).toEqual([...FAILURE_KINDS, 'stale', 'stopped'])
    expect(report.classes.find((row) => row.kind === 'interrupted')).toMatchObject({
      count: 2, totalTimeMs: 1_020_000, meanTimeMs: 510_000,
      firstSeen: '2026-09-06T10:00:00.000Z', lastSeen: '2026-09-07T10:00:00.000Z',
      clusters: [{ text: 'exit <n>, empty output', count: 2, exampleRunId: interruptedA }],
    })
    expect(report.classes.find((row) => row.kind === 'stale')?.count).toBe(1)
    expect(report.falseVerdicts.find((row) => row.kind === 'escaped')).toMatchObject({ verdicts: 1, falseVerdicts: 1, rate: 1 })
    expect(report.falseVerdicts.find((row) => row.kind === 'harness')).toMatchObject({ verdicts: 1, falseVerdicts: 1, rate: 1 })
    expect(report.landingRefusals).toBe(1)
    expect(report.flakes).toEqual([])
    expect(report.header).toContain('never routing or scoring evidence')
    expect(report.header).toContain('reclassify audit rows with cleared:true')
    expect(report.header).toContain('Contention is waits, refusals and invalidations')
    expect(report.contention.resources.map((row) => row.kind)).toEqual([
      'trunk', 'main_checkout', 'store', 'cpu', 'vendor', 'review', 'register', 'lock',
    ])
    expect(report.contention.resources.every((row) => row.count === 0)).toBe(true)

    const cli = Bun.spawnSync([
      process.execPath, new URL('./cli.ts', import.meta.url).pathname, 'health', '--days', '14', '--json',
    ], { env: process.env, stdout: 'pipe', stderr: 'pipe' })
    expect(cli.exitCode, cli.stderr.toString()).toBe(0)
    const output = JSON.parse(cli.stdout.toString())
    expect(output.classes.find((row: { kind: string }) => row.kind === 'interrupted').count).toBe(2)
    expect(output.landingRefusals).toBe(1)
    expect(output.flakes).toEqual([])
  })

  test('shows the flake table', () => {
    const now = new Date('2026-09-07T12:00:00.000Z')
    db().query(
      `INSERT INTO test_flake (test, file, load_at_failure, signal, at) VALUES (?,?,?,?,?)`,
    ).run(
      'a killed holder is reclaimed, and another project never waits on it',
      'src/landing-1.cli.test.ts',
      JSON.stringify({ gates: 2, loadavg: 0, ncpu: 0, freeMem: 0 }),
      'timeout',
      '2026-09-07T18:00:00.000Z',
    )
    db().query(
      `INSERT INTO test_flake (test, file, load_at_failure, signal, at) VALUES (?,?,?,?,?)`,
    ).run(
      'landing binds confinement',
      'src/landing-2.cli.test.ts',
      JSON.stringify({ gates: 4, loadavg: 5.1, ncpu: 8, freeMem: 1_500_000_000 }),
      'exit-143',
      '2026-09-06T11:00:00.000Z',
    )
    db().query(
      `INSERT INTO test_flake (test, file, load_at_failure, signal, at) VALUES (?,?,?,?,?)`,
    ).run(
      'landing binds confinement',
      'src/landing-2.cli.test.ts',
      JSON.stringify({ gates: 3, loadavg: 4.2, ncpu: 8, freeMem: 2_000_000_000 }),
      'exit-143',
      '2026-09-07T11:00:00.000Z',
    )
    const report = harnessHealth(14, db(), now)
    expect(report.flakes).toEqual([
      {
        test: 'landing binds confinement',
        file: 'src/landing-2.cli.test.ts',
        count: 2,
        loadAtFailure: { gates: 3, loadavg: 4.2, ncpu: 8, freeMem: 2_000_000_000 },
        signal: 'exit-143',
      },
      {
        test: 'a killed holder is reclaimed, and another project never waits on it',
        file: 'src/landing-1.cli.test.ts',
        count: 1,
        loadAtFailure: { gates: 2, loadavg: 0, ncpu: 0, freeMem: 0 },
        signal: 'timeout',
      },
    ])
    const cli = Bun.spawnSync([
      process.execPath, new URL('./cli.ts', import.meta.url).pathname, 'health', '--days', '14',
    ], { env: process.env, stdout: 'pipe', stderr: 'pipe' })
    expect(cli.exitCode, cli.stderr.toString()).toBe(0)
    const text = cli.stdout.toString()
    expect(text).toContain('FLAKES')
    expect(text).toContain('landing binds confinement')
    expect(text).toContain('src/landing-2.cli.test.ts')
    expect(text).toContain('gates=3')
    expect(text).toContain('signal=exit-143')
  })

  test('lists landings that reached trunk with a post-step error', () => {
    db().query(
      `INSERT INTO landing (project, branch, status, started_at, error)
       VALUES ('fixture', 'DEV-373', 'install_failed', ?, ?)`,
    ).run('2026-09-07T10:00:00.000Z', 'landing reached trunk at abc, but hub migrate failed: stub-fail')
    const cli = Bun.spawnSync([
      process.execPath, new URL('./cli.ts', import.meta.url).pathname, 'health', '--days', '14',
    ], { env: process.env, stdout: 'pipe', stderr: 'pipe' })
    expect(cli.exitCode, cli.stderr.toString()).toBe(0)
    expect(cli.stdout.toString()).toContain('landed with post-step error')
    expect(cli.stdout.toString()).toContain('fixture DEV-373')
    expect(cli.stdout.toString()).toContain('hub migrate failed: stub-fail')
  })

  test('uses UTC-midnight boundaries for both counts and sparkline buckets', () => {
    const now = new Date('2026-09-07T12:00:00.000Z')
    addRun({ agent: 'grok', job: 'review-lens', status: 'failed', kind: 'timeout', startedAt: '2026-09-05T00:00:00.000Z' })
    addRun({ agent: 'grok', job: 'review-lens', status: 'failed', kind: 'timeout', startedAt: '2026-09-04T23:59:59.999Z' })
    addRun({ agent: 'grok', job: 'review-lens', status: 'failed', kind: 'timeout', startedAt: '2026-09-07T11:00:00.000Z' })

    const report = harnessHealth(3, db(), now)
    const timeout = report.classes.find((row) => row.kind === 'timeout')!
    expect(report.from).toBe('2026-09-05T00:00:00.000Z')
    expect(timeout.count).toBe(2)
    expect(timeout.sparkline.reduce((sum, point) => sum + point.count, 0)).toBe(timeout.count)
  })

  test('contention sums per resource and names waits suffered versus invalidations caused', () => {
    const now = new Date('2026-09-07T12:00:00.000Z')
    insertContention(db(), {
      at: '2026-09-07T10:00:00.000Z', sessionId: 'session-a',
      resourceKind: 'lock', resourceKey: 'landing', eventKind: 'wait', durationMs: 1_000,
    })
    insertContention(db(), {
      at: '2026-09-07T10:01:00.000Z', sessionId: 'session-a',
      resourceKind: 'lock', resourceKey: 'landing', eventKind: 'wait', durationMs: 3_000,
    })
    insertContention(db(), {
      at: '2026-09-07T10:02:00.000Z', sessionId: 'session-b',
      resourceKind: 'review', resourceKey: 'victim', eventKind: 'invalidation',
      cause: 'review 9', landingId: 4,
    })
    insertContention(db(), {
      at: '2026-09-06T10:00:00.000Z', sessionId: 'session-b',
      resourceKind: 'lock', resourceKey: 'create', eventKind: 'wait', durationMs: 500,
    })
    insertContention(db(), {
      at: '2026-08-01T10:00:00.000Z', sessionId: 'session-a',
      resourceKind: 'lock', resourceKey: 'landing', eventKind: 'wait', durationMs: 9_000,
    })

    const report = harnessHealth(3, db(), now)
    expect(report.contention.resources.find((row) => row.kind === 'lock')).toMatchObject({
      count: 3, totalDurationMs: 4_500, meanDurationMs: 1_500,
      topKeys: [{ key: 'landing', count: 2 }, { key: 'create', count: 1 }],
    })
    expect(report.contention.resources.find((row) => row.kind === 'review')).toMatchObject({
      count: 1, totalDurationMs: 0, meanDurationMs: 0,
      topKeys: [{ key: 'victim', count: 1 }],
    })
    expect(report.contention.sessions).toEqual([
      { sessionId: 'session-a', waitsSuffered: 2, invalidationsCaused: 0 },
      { sessionId: 'session-b', waitsSuffered: 1, invalidationsCaused: 1 },
    ])
    expect(report.header).toContain('never routing evidence')
  })
})
