import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { briefInjectionCursorFacts, recordBriefInjection } from './brief-injection.ts'

test('cursor facts count open cursors and the longest keyless idle time', () => {
  const database = new Database(':memory:')
  database.exec(`CREATE TABLE workflow_cursor (
    session_id TEXT, state TEXT, workflow_key TEXT, updated_at TEXT
  );
  INSERT INTO workflow_cursor VALUES
    ('session-a','running','DEV-1','2026-11-13T12:00:04.000Z'),
    ('session-a','awaiting-ruling','','2026-11-13T12:00:03.000Z'),
    ('session-a','running','','2026-11-13T12:00:01.000Z'),
    ('session-a','done','','2026-11-13T11:00:00.000Z'),
    ('session-b','running','','2026-11-13T11:00:00.000Z');`)
  expect(
    briefInjectionCursorFacts(database, 'session-a', Date.parse('2026-11-13T12:00:05.000Z')),
  ).toEqual({ cursors: 3, keylessCursors: 2, keylessIdleMaxMs: 4_000 })
  database.close()
})

test('recording persists the final size and matching outbox row atomically', () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  database
    .query(`INSERT INTO workflow_cursor
    (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
     workflow_version_record_id,catalogue_version_record_id,args,total_steps,created_at,updated_at)
    VALUES ('01990000-0000-7000-8000-000000000041',41,'fixture','explore','default','',
            'instance','session-a','01990000-0000-7000-8000-000000000042',
            '01990000-0000-7000-8000-000000000043','{}',3,
            '2026-11-13T11:59:00.000Z','2026-11-13T12:00:01.000Z')`)
    .run()
  const recorded = recordBriefInjection(
    { sessionId: 'session-a', source: 'compact', bytes: 10_100, lines: 120, chars: 10_001 },
    {
      database,
      now: () => '2026-11-13T12:00:05.000Z',
      machine: () => '01990000-0000-7000-8000-000000000099',
    },
  )
  expect(recorded).toMatchObject({
    cursors: 1,
    keylessCursors: 1,
    keylessIdleMaxMs: 4_000,
    overCap: true,
  })
  expect(
    database
      .query(`SELECT session_id,source,bytes,lines,cursors,keyless_cursors,
      keyless_idle_max_ms,over_cap FROM brief_injection`)
      .get(),
  ).toEqual({
    session_id: 'session-a',
    source: 'compact',
    bytes: 10_100,
    lines: 120,
    cursors: 1,
    keyless_cursors: 1,
    keyless_idle_max_ms: 4_000,
    over_cap: 1,
  })
  const outbox = database
    .query<{ kind: string; payload: string }, []>('SELECT kind,payload FROM outbox')
    .get()!
  expect(outbox.kind).toBe('brief_injection')
  expect(JSON.parse(outbox.payload)).toMatchObject({ bytes: 10_100, lines: 120, overCap: true })
  database.close()
})
