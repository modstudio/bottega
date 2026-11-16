import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { HOOK_EMISSION_KINDS, recordHookEmission } from './hook-emission.ts'

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

test('Python helper uses the shared hook emission kind vocabulary', () => {
  const source = readFileSync(resolve(import.meta.dir, '../../hooks/hook_emission.py'), 'utf8')
  const tuple = source.match(/HOOK_EMISSION_KINDS = \((.*?)\)/s)?.[1]
  expect(tuple).toBeDefined()
  const kinds = [...tuple!.matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
  expect(kinds).toEqual([...HOOK_EMISSION_KINDS])
})
