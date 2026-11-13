import { describe, expect, test } from 'bun:test'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { pendingForSession, unscoredCount, voidedSql } from '../evidence/evidence-query.ts'

describe('what counts as unscored', () => {
  test('every terminal, served, non-probe, unjudged run is owed a judgment', () => {
    addRun({ agent: 'grok', job: 'craft' })
    addRun({ agent: 'grok', job: 'craft', probe: 1 })
    addRun({ agent: 'grok', job: 'craft', status: 'failed', kind: 'contract' })
    addRun({ agent: 'grok', job: 'craft', status: 'stale' })
    addRun({ agent: 'grok', job: 'craft', status: 'failed', kind: 'auth' })
    addRun({ agent: 'grok', job: 'craft', status: 'running' })
    score(addRun({ agent: 'grok', job: 'craft' }), 'full', 'right')
    expect(unscoredCount()).toBe(3)
  })

  test('doctor and pending cannot disagree, because they share the rule', () => {
    const mine = addRun({ agent: 'grok', job: 'craft' })
    db().query('UPDATE run SET session_id=? WHERE record_id=?').run('S', mine)
    addRun({ agent: 'grok', job: 'craft', status: 'failed', kind: 'contract', session: 'S' })
    expect(pendingForSession('S').length).toBe(2)
    expect(unscoredCount()).toBe(2)
  })

  test('the count honors the dashboard window', () => {
    const old = addRun({ agent: 'grok', job: 'craft' })
    db()
      .query('UPDATE run SET started_at=? WHERE record_id=?')
      .run(new Date(Date.now() - 60 * 86_400_000).toISOString(), old)
    addRun({ agent: 'grok', job: 'craft' })
    expect(unscoredCount()).toBe(2)
    expect(unscoredCount(new Date(Date.now() - 7 * 86_400_000).toISOString())).toBe(1)
  })

  test('empty-string exclusion is voided in SQL, matching IS NOT NULL not truthiness', () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query("UPDATE run SET evidence_excluded='' WHERE record_id=?").run(id)
    const row = db()
      .query(`SELECT ${voidedSql('r')} AS voided FROM run r WHERE record_id=?`)
      .get(id) as { voided: number }
    expect(row).toEqual({ voided: 1 })
    const nulled = db()
      .query(`SELECT ${voidedSql('r')} AS voided FROM run r WHERE record_id=?`)
      .get(addRun({ agent: 'codex', job: 'implement', status: 'asking' })) as { voided: number }
    expect(nulled).toEqual({ voided: 0 })
  })
})
