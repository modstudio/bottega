import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { backfillBriefInjections } from './brief-injection-outbox.ts'

test('brief injection backfill enqueues every local event once', () => {
  const database = migratedTestDatabase()
  database
    .query("INSERT INTO schema_meta (key,value) VALUES ('machine_id',?)")
    .run('01990000-0000-7000-8000-000000000099')
  database
    .query(`INSERT INTO brief_injection
    (record_id,session_id,at,source,bytes,lines,cursors,keyless_cursors,keyless_idle_max_ms,over_cap)
    VALUES ('01990000-0000-7000-8000-000000000041','session-a','2026-11-13T12:00:00.000Z',
            'compact',10120,80,2,1,4000,1)`)
    .run()

  expect(backfillBriefInjections(database, '2026-11-13T12:01:00.000Z')).toBe(1)
  expect(backfillBriefInjections(database, '2026-11-13T12:02:00.000Z')).toBe(0)
  const row = database
    .query<{ kind: string; payload: string }, []>('SELECT kind,payload FROM outbox')
    .get()!
  expect(row.kind).toBe('brief_injection')
  expect(JSON.parse(row.payload)).toMatchObject({
    sessionId: 'session-a',
    bytes: 10_120,
    lines: 80,
    cursors: 2,
    keylessCursors: 1,
    keylessIdleMaxMs: 4_000,
    overCap: true,
  })
  database.close()
})
