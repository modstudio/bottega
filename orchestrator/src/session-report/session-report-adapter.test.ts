import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { factsForSession, sessionReport } from './session-report-adapter.ts'

test('hook-only sessions are reportable and facts honor the inclusive end boundary', async () => {
  const database = migratedTestDatabase()
  const insert = database.query(`INSERT INTO hook_emission
    (record_id,session_id,at,event,hook,kind,chars,lines,text_hash)
    VALUES (?,?,?,?,?,?,?,?,?)`)
  insert.run(
    '01990000-0000-7000-8000-000000000052',
    'session-hook-only',
    '2026-11-15T11:59:59.000Z',
    'Stop',
    'stop-summary',
    'systemMessage',
    23,
    2,
    '2'.repeat(64),
  )
  insert.run(
    '01990000-0000-7000-8000-000000000051',
    'session-hook-only',
    '2026-11-15T12:00:00.000Z',
    'PreToolUse',
    'git-guard',
    'denyReason',
    37,
    4,
    '1'.repeat(64),
  )
  insert.run(
    '01990000-0000-7000-8000-000000000053',
    'session-hook-only',
    '2026-11-15T12:00:00.001Z',
    'Stop',
    'stop-summary',
    'systemMessage',
    99,
    9,
    '3'.repeat(64),
  )
  insert.run(
    '01990000-0000-7000-8000-000000000054',
    'other-session',
    '2026-11-15T11:59:59.000Z',
    'Stop',
    'stop-summary',
    'systemMessage',
    101,
    10,
    '4'.repeat(64),
  )

  const report = await sessionReport(
    {
      sessions: ['session-hook-only'],
      all: false,
      since: '2026-11-15T11:59:00.000Z',
      until: '2026-11-15T12:00:00.000Z',
    },
    { database, now: () => '2026-11-15T13:00:00.000Z' },
  )
  expect(report.sessions.map((row) => row.sessionId)).toEqual(['session-hook-only'])

  const facts = await factsForSession(database, 'session-hook-only', '2026-11-15T12:00:00.000Z')
  expect(facts.runs).toEqual([])
  expect(facts.cursors).toEqual([])
  expect(facts.hookEmissions).toEqual([
    {
      at: '2026-11-15T11:59:59.000Z',
      event: 'Stop',
      kind: 'systemMessage',
      chars: 23,
      textHash: '2'.repeat(64),
    },
    {
      at: '2026-11-15T12:00:00.000Z',
      event: 'PreToolUse',
      kind: 'denyReason',
      chars: 37,
      textHash: '1'.repeat(64),
    },
  ])
  database.close()
})
