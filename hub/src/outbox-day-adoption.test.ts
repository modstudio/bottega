import { afterAll, beforeEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigRoot } from '../../shared/config-directory.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { drainHostedOutbox, listHostedOutbox } from './outbox.ts'
import { listOutboxTrace } from './outbox-trace.ts'
import { HOSTED_DAY_TABLE, type HostedPushOutcome } from './push-contract.ts'
import type { HostedTaskIdentity } from './task-client.ts'

const localId = '01990000-0000-7000-8000-000000002611'
const hostedId = '01990000-0000-7000-8000-000000002612'
const day = '2026-11-20'
const machineId = HUB_MIGRATION_BACKFILL_VALUES.machine_id
const identity: HostedTaskIdentity = {
  userId: 'user-one',
  activeSpaceId: 'space-one',
  memberships: [{ spaceId: 'space-one', slug: 'one', permission: 'write' }],
  capabilities: { spacePush: true, spacePushTables: [HOSTED_DAY_TABLE], dayDelete: true },
}

beforeEach(() => {
  resetFixtureStore()
  writeTransaction((conn) => {
    conn
      .query(`INSERT INTO day(record_id,machine_id,day,collected_at) VALUES (?,?,?,?)`)
      .run(localId, machineId, day, `${day}T23:00:00.000Z`)
    conn
      .query(`UPDATE hosted_outbox SET attempts=2,last_error='conflict' WHERE row_id=?`)
      .run(localId)
  })
})
afterAll(resetFixtureStore)

const rejected = (machine: string | null): HostedPushOutcome => ({
  id: localId,
  status: 'rejected',
  reason: `day identity conflict: date ${day} belongs to UUID ${hostedId}, not incoming UUID ${localId}`,
  conflict: {
    code: 'day-identity-conflict',
    day,
    incomingId: localId,
    existingId: hostedId,
    machineId: machine,
  },
})

test('a structured natural-key refusal adopts the hosted day id and requeues', async () => {
  const report = await drainHostedOutbox({
    identity: async () => identity,
    registered: () => [],
    personalSpace: async () => 'space-one',
    push: async () => [rejected(machineId)],
    clock: () => '2026-11-21T00:00:00.000Z',
  })

  expect(report).toMatchObject({ rejected: 1, quarantined: 0 })
  expect(db().query(`SELECT record_id FROM day WHERE day=?`).get(day)).toEqual({
    record_id: hostedId,
  })
  expect(listHostedOutbox()).toEqual([
    expect.objectContaining({
      id: hostedId,
      row_id: hostedId,
      operation: 'upsert',
      attempts: 0,
      quarantined_at: null,
    }),
  ])
  expect(listOutboxTrace()).toEqual([
    expect.objectContaining({ row_id: localId, outcome: 'rejected' }),
  ])
})

test('an id-collision refusal still quarantines', async () => {
  const report = await drainHostedOutbox({
    identity: async () => identity,
    registered: () => [],
    personalSpace: async () => 'space-one',
    push: async () => [rejected(null)],
    clock: () => '2026-11-21T00:00:00.000Z',
  })

  expect(report).toMatchObject({ rejected: 1, quarantined: 1 })
  expect(db().query(`SELECT record_id FROM day WHERE day=?`).get(day)).toEqual({
    record_id: localId,
  })
  expect(listHostedOutbox()[0]).toMatchObject({
    row_id: localId,
    attempts: 3,
    quarantine_reason: expect.stringContaining('day identity conflict'),
  })
})

test('an outcome without a day conflict does not read malformed machine identity', async () => {
  const configPath = join(resolveConfigRoot(process.env), 'machine.toml')
  const originalConfig = readFileSync(configPath, 'utf8')
  writeFileSync(configPath, '[machine]\nid = "not-a-uuid"\n')
  try {
    const report = await drainHostedOutbox({
      identity: async () => identity,
      registered: () => [],
      personalSpace: async () => 'space-one',
      push: async () => [{ id: localId, status: 'rejected', reason: 'ordinary refusal' }],
      clock: () => '2026-11-21T00:00:00.000Z',
    })

    expect(report).toMatchObject({ rejected: 1, quarantined: 1 })
    expect(listHostedOutbox()[0]).toMatchObject({
      row_id: localId,
      attempts: 3,
      quarantine_reason: 'ordinary refusal',
    })
  } finally {
    writeFileSync(configPath, originalConfig)
  }
})

test('an adoption that loses its generation race leaves the day queued and records later outcomes', async () => {
  const laterId = '01990000-0000-7000-8000-000000002613'
  const laterDay = '2026-11-21'
  writeTransaction((conn) => {
    conn
      .query(`INSERT INTO day(record_id,machine_id,day,collected_at) VALUES (?,?,?,?)`)
      .run(laterId, machineId, laterDay, `${laterDay}T23:00:00.000Z`)
  })
  const initialGeneration = listHostedOutbox().find(({ id }) => id === localId)!.generation

  const report = await drainHostedOutbox({
    identity: async () => identity,
    registered: () => [],
    personalSpace: async () => 'space-one',
    push: async () => {
      writeTransaction((conn) =>
        conn.query(`UPDATE hosted_outbox SET generation=generation+1 WHERE id=?`).run(localId),
      )
      return [rejected(machineId), { id: laterId, status: 'rejected', reason: 'later refusal' }]
    },
    clock: () => '2026-11-22T00:00:00.000Z',
  })

  expect(report).toMatchObject({ rejected: 1, quarantined: 0 })
  expect(db().query(`SELECT record_id FROM day WHERE day=?`).get(day)).toEqual({
    record_id: localId,
  })
  expect(listHostedOutbox().find(({ id }) => id === localId)).toMatchObject({
    id: localId,
    row_id: localId,
    generation: initialGeneration + 1,
    attempts: 2,
  })
  expect(listHostedOutbox().find(({ id }) => id === laterId)).toMatchObject({
    attempts: 1,
    last_error: 'later refusal',
  })
  expect(listOutboxTrace()).toEqual([
    expect.objectContaining({ row_id: laterId, outcome: 'rejected', reason: 'later refusal' }),
  ])
})
