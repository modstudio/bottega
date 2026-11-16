import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { recordHookEmission } from './hook-emission.ts'

const valid = {
  sessionId: 'session-a',
  event: 'Stop',
  hook: 'stop-summary',
  kind: 'systemMessage' as const,
  chars: 12,
  lines: 1,
  textHash: 'a'.repeat(64),
}

test('recording persists a local row and matching outbox payload', () => {
  const database = migratedTestDatabase()
  const recorded = recordHookEmission(valid, {
    database,
    now: () => '2026-11-15T12:00:00.000Z',
    machine: () => '01990000-0000-7000-8000-000000000099',
  })

  expect(
    database
      .query(`SELECT record_id,session_id,at,event,hook,kind,chars,lines,text_hash
              FROM hook_emission`)
      .get(),
  ).toEqual({
    record_id: recorded.id,
    session_id: valid.sessionId,
    at: recorded.at,
    event: valid.event,
    hook: valid.hook,
    kind: valid.kind,
    chars: valid.chars,
    lines: valid.lines,
    text_hash: valid.textHash,
  })
  const outbox = database
    .query<{ row_id: string; payload: string }, []>(
      "SELECT row_id,payload FROM outbox WHERE kind='hook_emission'",
    )
    .get()!
  expect(outbox.row_id).toBe(recorded.id)
  expect(JSON.parse(outbox.payload)).toMatchObject({
    id: recorded.id,
    sessionId: valid.sessionId,
    event: valid.event,
    hook: valid.hook,
    kind: valid.kind,
    chars: valid.chars,
    lines: valid.lines,
    textHash: valid.textHash,
  })
  database.close()
})

test.each([
  ['unknown kind', { kind: 'unknown' }],
  ['negative chars', { chars: -1 }],
  ['malformed hash', { textHash: 'not-a-hash' }],
] as const)('%s is refused without writing', (_label, override) => {
  const database = migratedTestDatabase()
  expect(() =>
    recordHookEmission({ ...valid, ...override } as typeof valid, { database }),
  ).toThrow()
  expect(
    database.query<{ count: number }, []>('SELECT count(*) count FROM hook_emission').get()!.count,
  ).toBe(0)
  expect(
    database.query<{ count: number }, []>('SELECT count(*) count FROM outbox').get()!.count,
  ).toBe(0)
  database.close()
})
