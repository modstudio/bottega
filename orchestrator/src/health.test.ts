import { describe, expect, test } from 'bun:test'
import { addRun, db } from '../test/fixture.ts'
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
    expect(report.header).toContain('never routing or scoring evidence')
    expect(report.header).toContain('reclassify audit rows with cleared:true')

    const cli = Bun.spawnSync([
      process.execPath, new URL('./cli.ts', import.meta.url).pathname, 'health', '--days', '14', '--json',
    ], { env: process.env, stdout: 'pipe', stderr: 'pipe' })
    expect(cli.exitCode, cli.stderr.toString()).toBe(0)
    const output = JSON.parse(cli.stdout.toString())
    expect(output.classes.find((row: { kind: string }) => row.kind === 'interrupted').count).toBe(2)
    expect(output.landingRefusals).toBe(1)
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
})
