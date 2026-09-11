import { describe,expect,test } from 'bun:test'
import { addRun,candidates,db,score,weigh } from '../test/fixture.ts'
import { reclassifyFailuresCommand } from './failure-commands.ts'

describe('reclassify-failures', () => {
const runCli = (...args: string[]) => {
    const lines: string[] = []
    try {
      reclassifyFailuresCommand({ has: (name) => args.includes(`--${name}`) }, { log: (...values) => lines.push(values.join(' ')) })
      return { exitCode: 0, stdout: new TextEncoder().encode(lines.join('\n')) }
    } catch (cause) {
      return { exitCode: 1, stdout: new TextEncoder().encode(lines.join('\n')), error: cause }
    }
  }
test('reclassifies only failed rows whose own error has the DEV-122 signature', () => {
    const startedAt = '2026-09-03T12:00:00.000Z'
    const quotaError = 'Internal error: { "message": "API error (status 402 Payment Required): Grok Build usage exhausted" }\nfull stored detail'
    const successful = addRun({
      agent: 'grok', job: 'review-lens', status: 'ok', kind: 'other', startedAt,
    })
    score(successful, 'full', 'right')
    const failed = addRun({
      agent: 'grok', job: 'review-lens', status: 'failed', kind: 'other', startedAt,
    })
    const nullKind = addRun({
      agent: 'codex', job: 'review-lens', status: 'failed', startedAt,
    })
    const unrelated = addRun({
      agent: 'grok', job: 'review-lens', status: 'stale', kind: 'other', startedAt,
    })
    db().query('UPDATE run SET error=? WHERE id=?').run(quotaError, successful)
    db().query('UPDATE run SET error=? WHERE id=?').run(quotaError, failed)
    db().query('UPDATE run SET error=? WHERE id=?').run(quotaError, nullKind)
    db().query('UPDATE run SET error=? WHERE id=?').run('abandoned by architect', unrelated)

    const before = candidates('review-lens').find((c) => c.agent === 'grok')!
    expect(before.failures).toBe(2)
    expect(before.evidence).toBe(3)

    const dry = runCli('reclassify-failures', '--dry-run')
    expect(dry.exitCode).toBe(0)
    const dryOut = new TextDecoder().decode(dry.stdout)
    expect(dryOut).toContain('BEFORE (all failed/stale rows)')
    expect(dryOut).toContain('grok  other  2')
    expect(dryOut).toContain(`run ${failed}  grok/review-lens  [failed]  other -> quota`)
    expect(dryOut).toContain(`run ${nullKind}  codex/review-lens  [failed]  null -> quota`)
    expect(dryOut).toContain(quotaError)
    expect(dryOut).toContain('AFTER (all failed/stale rows)')
    expect(dryOut).toContain('grok  other  1')
    expect(dryOut).toContain('grok  quota  1')
    expect(dryOut).toContain('2 rows would be reclassified — dry run, no writes.')
    expect(db().query('SELECT failure_kind FROM run WHERE id=?').get(failed))
      .toEqual({ failure_kind: 'other' })

    const applied = runCli('reclassify-failures')
    expect(applied.exitCode).toBe(0)
    expect(new TextDecoder().decode(applied.stdout)).toContain('2 rows reclassified.')
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(failed))
      .toEqual({ status: 'failed', failure_kind: 'quota' })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(successful))
      .toEqual({ status: 'ok', failure_kind: 'other' })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(nullKind))
      .toEqual({ status: 'failed', failure_kind: 'quota' })
    expect(db().query('SELECT status, failure_kind FROM run WHERE id=?').get(unrelated))
      .toEqual({ status: 'stale', failure_kind: 'other' })

    const after = candidates('review-lens').find((c) => c.agent === 'grok')!
    expect(after.failures).toBe(1)
    expect(after.evidence).toBe(2)
    expect(after.score).toBeCloseTo(
      (weigh('full', 'right') + weigh('none', null)) / 2,
    )

    const again = runCli('reclassify-failures')
    expect(again.exitCode).toBe(0)
    expect(new TextDecoder().decode(again.stdout)).toContain('PLAN (0 matched rows)')
    expect(new TextDecoder().decode(again.stdout)).toContain('0 rows reclassified.')
  }, 20_000)
})
