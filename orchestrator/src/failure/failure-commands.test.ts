import { describe, expect, test } from 'bun:test'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { candidates } from '../route/route.ts'
import { weigh } from '../score/score.ts'
import { reclassifiedFailureKind, reclassifyFailuresCommand } from './failure-commands.ts'

describe('reclassify-failures', () => {
  const runCli = (...args: string[]) => {
    const lines: string[] = []
    try {
      reclassifyFailuresCommand(
        { has: (name) => args.includes(`--${name}`) },
        { log: (...values) => lines.push(values.join(' ')) },
      )
      return { exitCode: 0, stdout: new TextEncoder().encode(lines.join('\n')) }
    } catch (cause) {
      return { exitCode: 1, stdout: new TextEncoder().encode(lines.join('\n')), error: cause }
    }
  }
  test('selects only a Goose contract failure carrying a rendered vendor error', () => {
    const error =
      'sandbox: host\nRan into this error: Rate limit exceeded: Provider returned error.\n\n' +
      'Please retry if you think this is a transient or recoverable error.'
    expect(reclassifiedFailureKind('contract', error, 'goose')).toBe('provider_error')
    expect(reclassifiedFailureKind('contract', error, 'codex')).toBeNull()
    expect(reclassifiedFailureKind('contract', 'Rate limit exceeded', 'goose')).toBeNull()
    expect(reclassifiedFailureKind('quota', error, 'goose')).toBeNull()
  })

  test('reclassifies stored Goose vendor failures through the registered harness', () => {
    const fixtures = [
      ['Ran into this error: Rate limit exceeded: Provider returned error.', 'provider_error'],
      [
        'Ran into this error trying to compact: Server error: Upstream error from Inception: request failed',
        'provider_error',
      ],
      ['Ran into this error: Server error: Upstream idle timeout exceeded.', 'provider_error'],
      [
        'Ran into this error: Server error: Upstream error from OpenInference: request failed',
        'provider_error',
      ],
      [
        'Ran into this error: Server error: Upstream error from Alibaba: request failed',
        'provider_error',
      ],
      [
        'Ran into this error: Server error: This request requires more credits, or fewer max_tokens than requested.',
        'billing',
      ],
      [
        'Ran into this error trying to compact: Request failed: Bad request (400): invalid request',
        'provider_error',
      ],
    ] as const
    const runs = fixtures.map(([line]) => {
      const recordId = addRun({
        agent: 'codex',
        job: 'review-lens',
        status: 'failed',
        kind: 'contract',
      })
      const stored =
        `reply.json missing; final message reply did not match the worker contract:\n${line}\n` +
        'reply.json missing at /tmp/reply.json; used final-message fallback\n' +
        'Failover refused: selected model is at capacity and the chain cannot retry.'
      db().query('UPDATE run SET error=? WHERE record_id=?').run(stored, recordId)
      return recordId
    })
    const nonGoose = addRun({
      agent: 'grok',
      job: 'review-lens',
      status: 'failed',
      kind: 'contract',
    })
    db()
      .query('UPDATE run SET error=? WHERE record_id=?')
      .run(`prefix\n${fixtures[0]![0]}`, nonGoose)
    db().query("UPDATE agent SET harness='goose' WHERE name='codex'").run()

    const dry = runCli('reclassify-failures', '--dry-run')
    expect(new TextDecoder().decode(dry.stdout)).toContain('PLAN (7 matched rows)')
    expect(db().query('SELECT failure_kind FROM run WHERE record_id=?').get(runs[0]!)).toEqual({
      failure_kind: 'contract',
    })

    const applied = runCli('reclassify-failures')
    expect(new TextDecoder().decode(applied.stdout)).toContain('7 rows reclassified.')
    expect(
      runs.map(
        (recordId) =>
          (
            db().query('SELECT failure_kind FROM run WHERE record_id=?').get(recordId) as {
              failure_kind: string
            }
          ).failure_kind,
      ),
    ).toEqual(fixtures.map(([, expected]) => expected))
    expect(db().query('SELECT failure_kind FROM run WHERE record_id=?').get(nonGoose)).toEqual({
      failure_kind: 'contract',
    })
  })

  test('reclassifies only failed rows whose own error has the DEV-122 signature', () => {
    const startedAt = '2026-09-03T12:00:00.000Z'
    const quotaError =
      'Internal error: { "message": "API error (status 402 Payment Required): Grok Build usage exhausted" }\nfull stored detail'
    const successful = addRun({
      agent: 'grok',
      job: 'review-lens',
      status: 'ok',
      kind: 'other',
      startedAt,
    })
    score(successful, 'full', 'right')
    const failed = addRun({
      agent: 'grok',
      job: 'review-lens',
      status: 'failed',
      kind: 'other',
      startedAt,
    })
    const nullKind = addRun({
      agent: 'codex',
      job: 'review-lens',
      status: 'failed',
      startedAt,
    })
    const unrelated = addRun({
      agent: 'grok',
      job: 'review-lens',
      status: 'stale',
      kind: 'other',
      startedAt,
    })
    db().query('UPDATE run SET error=? WHERE record_id=?').run(quotaError, successful)
    db().query('UPDATE run SET error=? WHERE record_id=?').run(quotaError, failed)
    db().query('UPDATE run SET error=? WHERE record_id=?').run(quotaError, nullKind)
    db().query('UPDATE run SET error=? WHERE record_id=?').run('abandoned by architect', unrelated)

    const before = candidates('review-lens').find((c) => c.agent === 'grok')!
    expect(before.failures).toBe(2)
    expect(before.evidence).toBe(3)

    const dry = runCli('reclassify-failures', '--dry-run')
    expect(dry.exitCode).toBe(0)
    expect(db().query('SELECT failure_kind FROM run WHERE record_id=?').get(failed)).toEqual({
      failure_kind: 'other',
    })

    const applied = runCli('reclassify-failures')
    expect(applied.exitCode).toBe(0)
    expect(
      db().query('SELECT status, failure_kind FROM run WHERE record_id=?').get(failed),
    ).toEqual({
      status: 'failed',
      failure_kind: 'billing',
    })
    expect(
      db().query('SELECT status, failure_kind FROM run WHERE record_id=?').get(successful),
    ).toEqual({
      status: 'ok',
      failure_kind: 'other',
    })
    expect(
      db().query('SELECT status, failure_kind FROM run WHERE record_id=?').get(nullKind),
    ).toEqual({
      status: 'failed',
      failure_kind: 'billing',
    })
    expect(
      db().query('SELECT status, failure_kind FROM run WHERE record_id=?').get(unrelated),
    ).toEqual({
      status: 'stale',
      failure_kind: 'other',
    })

    const after = candidates('review-lens').find((c) => c.agent === 'grok')!
    expect(after.failures).toBe(1)
    expect(after.evidence).toBe(2)
    expect(after.score).toBeCloseTo((weigh('full', 'right') + weigh('none', null)) / 2)

    const again = runCli('reclassify-failures')
    expect(again.exitCode).toBe(0)
    expect(db().query('SELECT failure_kind FROM run WHERE record_id=?').get(failed)).toEqual({
      failure_kind: 'billing',
    })
  }, 20_000)
})
