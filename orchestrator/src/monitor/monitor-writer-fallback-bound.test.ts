import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { FINAL_MESSAGE_FALLBACK_MARKER } from '../run/run-live.ts'
import { writerOkOnFallbackAtBoundConditions } from './monitor-writer-fallback-bound.ts'

test('reports only an ok writer killed at the bound with a final-message fallback', () => {
  const clock = Date.parse('2026-11-17T12:00:00.000Z')
  const fallback = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    startedAt: '2026-11-17T11:00:00.000Z',
    session: 'session-fallback',
  })
  const replyFile = addRun({
    agent: 'codex',
    job: 'fix',
    status: 'ok',
    startedAt: '2026-11-17T11:05:00.000Z',
  })
  db()
    .query('UPDATE run SET exit_code=143,error=? WHERE record_id=?')
    .run(`reply.json missing at /tmp/reply.json; ${FINAL_MESSAGE_FALLBACK_MARKER}`, fallback)
  db().query('UPDATE run SET exit_code=143,error=NULL WHERE record_id=?').run(replyFile)

  expect(writerOkOnFallbackAtBoundConditions(db(), clock)).toEqual([
    {
      kind: 'writer-ok-on-fallback-at-bound',
      subject: `run:${fallback}`,
      since: '2026-11-17T11:00:00.000Z',
      ageMs: null,
      detail: `writing run ${fallback} was recorded ok from the final-message fallback after exit 143`,
      action: `inspect run ${fallback} and correct its terminal classification`,
      ownerSession: 'session-fallback',
    },
  ])
})
