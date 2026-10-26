import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { drainHostedOutbox, queueHostedChange } from './outbox.ts'
import {
  listOutboxTrace,
  OUTBOX_TRACE_RETENTION_MS,
  outboxTraceLines,
  pruneOutboxTrace,
  recordOutboxTrace,
} from './outbox-trace.ts'
import { HOSTED_INTERVAL_TABLE } from './push-contract.ts'
import type { HostedTaskIdentity } from './task-client.ts'

const identity: HostedTaskIdentity = {
  userId: 'user-one',
  activeSpaceId: 'space-one',
  memberships: [{ spaceId: 'space-one', slug: 'one', permission: 'write' as const }],
  capabilities: { spacePush: true, spacePushTables: [HOSTED_INTERVAL_TABLE] },
}
const project = {
  name: 'fixture',
  path: '/fixture',
  repository: true,
  settings: { keyPrefixes: ['FIX'] },
}

beforeEach(resetFixtureStore)

function insertInterval(id: string, ref: string): void {
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO interval(record_id,project,project_record_id,source,start_at,end_at,ref)
         VALUES (?,'fixture','project-id','orch','2026-10-12T12:00:00.000Z',
           '2026-10-12T12:01:00.000Z',?)`,
      )
      .run(id, ref),
  )
}

test('traces duplicate deletes, replacements, and rejections but not plain applied upserts', async () => {
  const deletedId = '01990000-0000-7000-8000-000000001001'
  writeTransaction((conn) => {
    queueHostedChange(conn, HOSTED_INTERVAL_TABLE, deletedId, 'delete')
    conn
      .query(`UPDATE hosted_outbox SET routing_space_id=? WHERE row_id=?`)
      .run('space-one', deletedId)
  })
  await drainHostedOutbox({
    identity: async () => identity,
    registered: () => [project],
    processKind: 'collector',
    clock: () => '2026-10-12T12:00:00.000Z',
    push: async () => [{ id: deletedId, status: 'duplicate' }],
  })

  const replacementId = '01990000-0000-7000-8000-000000001002'
  insertInterval(replacementId, 'orch:replacement')
  await drainHostedOutbox({
    identity: async () => identity,
    registered: () => [project],
    processKind: 'command',
    clock: () => '2026-10-12T12:01:00.000Z',
    push: async () => [
      {
        id: replacementId,
        status: 'applied',
        replacedId: '01990000-0000-7000-8000-000000001000',
      },
    ],
  })

  const supersededId = '01990000-0000-7000-8000-000000001005'
  const holderId = '01990000-0000-7000-8000-000000001006'
  insertInterval(supersededId, 'orch:superseded')
  await drainHostedOutbox({
    identity: async () => identity,
    registered: () => [project],
    processKind: 'command',
    clock: () => '2026-10-12T12:01:30.000Z',
    push: async () => [
      {
        id: supersededId,
        status: 'duplicate',
        reason: `interval superseded by newer UUID ${holderId}`,
      },
    ],
  })

  const rejectedId = '01990000-0000-7000-8000-000000001003'
  insertInterval(rejectedId, 'orch:rejected')
  await drainHostedOutbox({
    identity: async () => identity,
    registered: () => [project],
    processKind: 'command',
    clock: () => '2026-10-12T12:02:00.000Z',
    push: async () => [{ id: rejectedId, status: 'rejected', reason: 'bad interval' }],
  })

  const appliedId = '01990000-0000-7000-8000-000000001004'
  insertInterval(appliedId, 'orch:applied')
  await drainHostedOutbox({
    identity: async () => identity,
    registered: () => [project],
    push: async () => [{ id: appliedId, status: 'applied' }],
  })

  expect(
    listOutboxTrace().map((row) => ({
      row: row.row_id,
      destination: row.destination_space_id,
      operation: row.operation,
      outcome: row.outcome,
      reason: row.reason,
      process: row.process_kind,
    })),
  ).toEqual([
    {
      row: rejectedId,
      destination: 'space-one',
      operation: 'upsert',
      outcome: 'rejected',
      reason: 'bad interval',
      process: 'command',
    },
    {
      row: supersededId,
      destination: 'space-one',
      operation: 'upsert',
      outcome: 'duplicate',
      reason: `interval superseded by newer UUID ${holderId}`,
      process: 'command',
    },
    {
      row: replacementId,
      destination: 'space-one',
      operation: 'upsert',
      outcome: 'replaced',
      reason: 'replaced interval 01990000-0000-7000-8000-000000001000',
      process: 'command',
    },
    {
      row: deletedId,
      destination: 'space-one',
      operation: 'delete',
      outcome: 'duplicate',
      reason: null,
      process: 'collector',
    },
  ])
  expect(JSON.parse(outboxTraceLines(deletedId, true)[0]!)).toHaveLength(1)
})

test('trace pruning removes rows older than the named retention', () => {
  writeTransaction((conn) => {
    for (const [rowId, createdAt] of [
      ['old', '2026-09-01T00:00:00.000Z'],
      ['new', '2026-10-12T00:00:00.000Z'],
    ] as const)
      recordOutboxTrace(conn, {
        table_name: HOSTED_INTERVAL_TABLE,
        row_id: rowId,
        operation: 'delete',
        destination_space_id: 'space-one',
        outcome: 'duplicate',
        reason: null,
        generation: 1,
        process_kind: 'collector',
        created_at: createdAt,
      })
  })
  expect(pruneOutboxTrace('2026-10-12T12:00:00.000Z', OUTBOX_TRACE_RETENTION_MS)).toBe(1)
  expect(
    db().query<{ row_id: string }, []>(`SELECT row_id FROM hosted_outbox_trace`).all(),
  ).toEqual([{ row_id: 'new' }])
})
