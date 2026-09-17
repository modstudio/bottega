import { describe, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { duelMatrices, parseRunIds, recordDuels } from './duel.ts'

describe('pairwise judgements', () => {
  test('--better-than accepts a comma list of run ids', () => {
    expect(parseRunIds('12,13,99', '--better-than')).toEqual([12, 13, 99])
    expect(() => parseRunIds('', '--better-than')).toThrow('at least one run id')
    expect(() => parseRunIds('12,nope', '--better-than')).toThrow('separated by commas')
    expect(() => parseRunIds('12,12', '--better-than')).toThrow('same run more than once')
  })

  test('one winner can be recorded against every loser in a fan-out', () => {
    const winner = addRun({ agent: 'codex', job: 'craft', session: 'session-A' })
    const grok = addRun({ agent: 'grok', job: 'craft', session: 'session-A' })
    const agy = addRun({ agent: 'agy', job: 'craft', session: 'session-A' })
    recordDuels(winner, [grok, agy], 'session-A', '2026-09-02T12:00:00.000Z')

    expect(
      db()
        .query(
          'SELECT job, winner_run_id, loser_run_id, session_id, at FROM duel ORDER BY loser_run_id',
        )
        .all(),
    ).toEqual([
      {
        job: 'craft',
        winner_run_id: winner,
        loser_run_id: grok,
        session_id: 'session-A',
        at: '2026-09-02T12:00:00.000Z',
      },
      {
        job: 'craft',
        winner_run_id: winner,
        loser_run_id: agy,
        session_id: 'session-A',
        at: '2026-09-02T12:00:00.000Z',
      },
    ])
    // Re-scoring does not duplicate the pair protected by the UNIQUE constraint.
    recordDuels(winner, [grok], 'session-A', '2026-09-02T13:00:00.000Z')
    expect((db().query('SELECT COUNT(*) AS n FROM duel').get() as { n: number }).n).toBe(2)
  })

  test('duels require distinct runs from the same job', () => {
    const craft = addRun({ agent: 'codex', job: 'craft', session: 'session-A' })
    const safety = addRun({ agent: 'grok', job: 'safety', session: 'session-A' })
    expect(() => recordDuels(craft, [craft], 'session-A', new Date().toISOString())).toThrow(
      'cannot be better than itself',
    )
    expect(() => recordDuels(craft, [safety], 'session-A', new Date().toISOString())).toThrow(
      'jobs differ',
    )
    expect((db().query('SELECT COUNT(*) AS n FROM duel').get() as { n: number }).n).toBe(0)
  })

  test('both runs must be judgeable by this session unless forced', () => {
    const mine = addRun({ agent: 'codex', job: 'craft', session: 'session-A' })
    const theirs = addRun({ agent: 'grok', job: 'craft', session: 'session-B' })
    expect(() => recordDuels(mine, [theirs], 'session-A', new Date().toISOString())).toThrow(
      'Both runs in a duel must be scoreable by this session',
    )
    recordDuels(mine, [theirs], 'session-A', new Date().toISOString(), true)
    expect((db().query('SELECT COUNT(*) AS n FROM duel').get() as { n: number }).n).toBe(1)
  })

  test('stats data is a per-job agent win-loss matrix', () => {
    const codex = addRun({ agent: 'codex', job: 'craft', session: 's' })
    const grok = addRun({ agent: 'grok', job: 'craft', session: 's' })
    const agy = addRun({ agent: 'agy', job: 'craft', session: 's' })
    const other = addRun({ agent: 'grok', job: 'safety', session: 's' })
    recordDuels(codex, [grok, agy], 's', new Date().toISOString())
    recordDuels(grok, [codex], 's', new Date().toISOString())
    recordDuels(
      other,
      [addRun({ agent: 'codex', job: 'safety', session: 's' })],
      's',
      new Date().toISOString(),
    )

    const matrix = duelMatrices('craft')
    expect(matrix).toHaveLength(1)
    expect(matrix[0]!.job).toBe('craft')
    expect(matrix[0]!.agents).toEqual(['agy', 'codex', 'grok'])
    expect(matrix[0]!.cells.codex!.grok).toEqual({ wins: 1, losses: 1 })
    expect(matrix[0]!.cells.codex!.agy).toEqual({ wins: 1, losses: 0 })
    expect(matrix[0]!.cells.agy!.grok).toEqual({ wins: 0, losses: 0 })
  })
})
