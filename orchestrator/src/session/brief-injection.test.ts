import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import {
  briefInjectionCursorFacts,
  recordBriefInjection,
  SESSION_START_SOURCES,
} from './brief-injection.ts'

test('cursor facts count supplied open cursors and the longest keyless idle time', () => {
  expect(
    briefInjectionCursorFacts(
      [
        { workflow_key: 'DEV-1', updated_at: '2026-11-13T12:00:04.000Z' },
        { workflow_key: '', updated_at: '2026-11-13T12:00:03.000Z' },
        { workflow_key: '', updated_at: '2026-11-13T12:00:01.000Z' },
      ],
      Date.parse('2026-11-13T12:00:05.000Z'),
    ),
  ).toEqual({ cursors: 3, keylessCursors: 2, keylessIdleMaxMs: 4_000 })
})

test('local migration SessionStart sources match the shared source vocabulary', () => {
  const migration = readFileSync(
    new URL('../../migrations/0221_brief_injection.sql', import.meta.url),
    'utf8',
  )
  const check = migration.match(/source IN \(([^)]+)\)/)?.[1]
  expect(check?.match(/'([^']+)'/g)?.map((source) => source.slice(1, -1))).toEqual([
    ...SESSION_START_SOURCES,
  ])
})

test('recording persists the final size and matching outbox row atomically', async () => {
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
  const recorded = await recordBriefInjection(
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
