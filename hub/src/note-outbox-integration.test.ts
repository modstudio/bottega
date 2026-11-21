import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { db, writeTransaction } from './db.ts'
import { sendHostedChanges } from './hosted-change-sender.ts'
import { DELETED_ON_HOSTED_RECORD_REASON } from './hosted-delete.ts'
import { createHostedNote } from './hosted-notes.ts'
import { applyHostedPushChangesInTransaction } from './hosted-push-changes.ts'
import { acknowledgeNote, createNote, dropNote, mergeNote } from './note.ts'
import type {
  HostedPushChange,
  ParsedHostedPushChange,
  PushedNote,
  PushedNoteAcknowledgement,
} from './push-contract.ts'
import { parseHostedPushItem } from './push-contract.ts'

const spaceId = '01990000-0000-7000-8000-000000001250'
const taskId = '01990000-0000-7000-8000-000000001251'
const projectId = '01990000-0000-7000-8000-000000001252'
const userId = '01990000-0000-7000-8000-000000001249'
const identity = { userId, spaceId }
let database: PGlite

const noteRow = (id: string, number: number, overrides: Partial<PushedNote> = {}): PushedNote => ({
  id,
  number,
  project: 'workshop',
  project_name: 'workshop',
  projectId,
  text: 'hosted text',
  area: null,
  anchors: '[{"kind":"run"}]',
  sightings: 1,
  created_at: '2026-10-09T10:00:00.000Z',
  last_seen_at: '2026-10-09T10:00:00.000Z',
  stale_at: null,
  stale_reason: null,
  promoted_task: null,
  promoted_task_id: null,
  updated_at: '2026-10-09T10:00:00.000Z',
  deleted_at: null,
  ...overrides,
})

async function seedHostedNote(row: PushedNote) {
  await database.query(
    `INSERT INTO hub_note
      (id,space_id,project_name,project_id,number,project,text,area,anchors,sightings,created_at,
       last_seen_at,stale_at,stale_reason,promoted_task,promoted_task_id,updated_at,deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      row.id,
      spaceId,
      row.project_name,
      row.projectId,
      row.number,
      row.project,
      row.text,
      row.area,
      row.anchors,
      row.sightings,
      row.created_at,
      row.last_seen_at,
      row.stale_at,
      row.stale_reason,
      row.promoted_task,
      row.promoted_task_id,
      row.updated_at,
      row.deleted_at,
    ],
  )
}

const unavailableHosted = {
  baseUrl: 'https://unreachable.example.test',
  token: 'test',
  fetch: async () => {
    throw new Error('hosted hub unavailable')
  },
}

const recordHosted = {
  baseUrl: 'https://record.example.test',
  token: 'test',
  recordSpace: spaceId,
  fetch: async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({
        userId,
        activeSpaceId: spaceId,
        memberships: [{ spaceId, slug: 'workshop', permission: 'write' }],
        capabilities: {
          projectNoteCounters: true,
          targetSpaceNotes: true,
          spacePush: true,
          spacePushTables: ['hub_note', 'hub_note_acknowledgement'],
        },
      })
    if (url.pathname === '/v1/changes') {
      const changes = JSON.parse(String(init?.body)) as HostedPushChange[]
      return Response.json(await apply(changes))
    }
    const match = /^\/v1\/notes\/([0-9a-f-]{36})$/i.exec(url.pathname)
    if (match) {
      const row = (
        await database.query(
          `SELECT *,number::int number,revision::int revision FROM hub_note
           WHERE id=$1 AND deleted_at IS NULL`,
          [match[1]!],
        )
      ).rows[0]
      return row ? Response.json(row) : Response.json({ error: 'note not found' }, { status: 404 })
    }
    return Response.json({ error: 'unexpected route' }, { status: 500 })
  },
}

function seedMachineNote(row: PushedNote) {
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO note
          (record_id,number,project,project_record_id,text,area,anchors,sightings,created_at,last_seen_at,
           stale_at,stale_reason,promoted_task)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.number,
        row.project,
        row.projectId ?? projectId,
        row.text,
        row.area,
        row.anchors,
        row.sightings,
        row.created_at,
        row.last_seen_at,
        row.stale_at,
        row.stale_reason,
        row.promoted_task,
      ),
  )
}

const parseInputs = (inputs: HostedPushChange[]): ParsedHostedPushChange[] =>
  inputs.map((input) => {
    const parsed = parseHostedPushItem(input)
    if ('outcome' in parsed) throw new Error(parsed.outcome.reason)
    return parsed.input
  })

const apply = (inputs: HostedPushChange[], selectedIdentity = identity) =>
  database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    sql.unsafe = (async (statement: string) =>
      (await transaction.query(statement)).rows) as SQL['unsafe']
    return applyHostedPushChangesInTransaction(sql, selectedIdentity, parseInputs(inputs))
  })

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId, userId })
  await database.query(
    `INSERT INTO project (id,space_id,name,created_at) VALUES ($1,$2,'workshop',now())`,
    [projectId, spaceId],
  )
  await apply([
    {
      table: 'hub_task',
      id: taskId,
      op: 'upsert',
      row: {
        id: taskId,
        key: 'DEV-1',
        project: 'workshop',
        project_name: 'workshop',
        projectId,
        title: 'First',
        status: 'active',
        status_category: 'active',
        parent_key: null,
        body: null,
        assignee: null,
        opened_at: '2026-10-09T10:00:00.000Z',
        closed_at: null,
        source: 'mcp',
        first_seen: '2026-10-09T10:00:00.000Z',
        last_seen: '2026-10-09T11:00:00.000Z',
        created_at: '2026-10-09T10:00:00.000Z',
        updated_at: '2026-10-09T11:00:00.000Z',
        deleted_at: null,
        next_document_number: 1,
      },
    },
  ])
})

afterAll(async () => {
  if (database) await database.close()
})

test('field compare-and-set compares note timestamps as instants and rejects a stale field', async () => {
  const noteId = '01990000-0000-7000-8000-000000001309'
  const initialSeenAt = '2026-10-09T10:00:00.000Z'
  const nextSeenAt = '2026-10-09T11:00:00.000Z'
  const initial = noteRow(noteId, 309, { last_seen_at: initialSeenAt })
  await seedHostedNote(initial)
  await apply([
    {
      table: 'hub_note',
      id: noteId,
      op: 'upsert',
      row: { ...initial, last_seen_at: nextSeenAt },
      fields: ['last_seen_at'],
      from: { last_seen_at: initialSeenAt },
    },
  ])
  try {
    await apply([
      {
        table: 'hub_note',
        id: noteId,
        op: 'upsert',
        row: { ...initial, last_seen_at: '2026-10-09T12:00:00.000Z' },
        fields: ['last_seen_at'],
        from: { last_seen_at: initialSeenAt },
      },
    ])
    throw new Error('expected a field conflict')
  } catch (error) {
    expect(error).toMatchObject({
      field: 'last_seen_at',
      currentRevision: '2',
      currentValue: new Date(nextSeenAt),
    })
    expect((error as Error).message).toContain(`cleared by: ${PLATFORM_SLUG} note list --json`)
  }
})

test('two machine sightings append once each and repeated delivery writes no change', async () => {
  const noteId = '01990000-0000-7000-8000-000000001310'
  const firstAnchor = '01990000-0000-7000-8000-000000001311'
  const secondAnchor = '01990000-0000-7000-8000-000000001312'
  const initial = noteRow(noteId, 310, {
    anchors: '[{"kind":"run"}]',
    sightings: 1,
    last_seen_at: '2026-10-09T12:00:00.000Z',
  })
  await seedHostedNote(initial)
  const sighting = (anchorId: string, seen: string): ParsedHostedPushChange => ({
    table: 'hub_note',
    id: noteId,
    op: 'upsert',
    fields: ['anchors', 'last_seen_at'],
    row: noteRow(noteId, 310, {
      anchors: JSON.stringify([{ kind: 'run' }, { id: anchorId, kind: 'run' }]),
      sightings: 2,
      last_seen_at: seen,
    }),
  })
  const first = sighting(firstAnchor, '2026-10-09T13:00:00.000Z')
  const second = sighting(secondAnchor, '2026-10-09T14:00:00.000Z')
  expect(await apply([first])).toEqual([{ id: noteId, status: 'applied' }])
  expect(await apply([second])).toEqual([{ id: noteId, status: 'applied' }])
  const beforeDuplicate = BigInt(
    (
      await database.query<{ seq: string | number }>(
        `SELECT COALESCE(max(seq),0) seq FROM record_change WHERE space_id=$1`,
        [spaceId],
      )
    ).rows[0]!.seq,
  )
  expect(await apply([first])).toEqual([{ id: noteId, status: 'duplicate' }])
  expect(await apply([second])).toEqual([{ id: noteId, status: 'duplicate' }])
  expect(
    BigInt(
      (
        await database.query<{ seq: string | number }>(
          `SELECT COALESCE(max(seq),0) seq FROM record_change WHERE space_id=$1`,
          [spaceId],
        )
      ).rows[0]!.seq,
    ),
  ).toBe(beforeDuplicate)
  const stored = (
    await database.query<{ anchors: unknown; sightings: number; last_seen_at: Date }>(
      `SELECT anchors,sightings,last_seen_at FROM hub_note WHERE id=$1`,
      [noteId],
    )
  ).rows[0]!
  expect(stored.sightings).toBe(3)
  expect(JSON.parse(String(stored.anchors))).toEqual([
    { kind: 'run' },
    { id: firstAnchor, kind: 'run' },
    { id: secondAnchor, kind: 'run' },
  ])
  expect(stored.last_seen_at.toISOString()).toBe('2026-10-09T14:00:00.000Z')
})

test('an older note timestamp is a duplicate and a drop patch preserves hosted text', async () => {
  const noteId = '01990000-0000-7000-8000-000000001313'
  const stored = noteRow(noteId, 313, {
    text: 'someone else changed this',
    last_seen_at: '2026-10-09T14:00:00.000Z',
  })
  await seedHostedNote(stored)
  expect(
    await apply([
      {
        table: 'hub_note',
        id: noteId,
        op: 'upsert',
        fields: ['last_seen_at'],
        row: { ...stored, last_seen_at: '2026-10-09T13:00:00.000Z' },
      },
    ]),
  ).toEqual([{ id: noteId, status: 'duplicate' }])
  expect(
    await apply([
      {
        table: 'hub_note',
        id: noteId,
        op: 'upsert',
        fields: ['stale_at', 'stale_reason', 'last_seen_at'],
        row: {
          ...stored,
          text: 'stale machine text',
          stale_at: '2026-10-09T15:00:00.000Z',
          stale_reason: 'dropped: done',
          last_seen_at: '2026-10-09T15:00:00.000Z',
        },
      },
    ]),
  ).toEqual([{ id: noteId, status: 'applied' }])
  expect(
    (await database.query(`SELECT text,stale_reason FROM hub_note WHERE id=$1`, [noteId])).rows,
  ).toEqual([{ text: 'someone else changed this', stale_reason: 'dropped: done' }])
})

test('a sighting pushed after the hosted note was deleted is rejected', async () => {
  const noteId = '01990000-0000-7000-8000-000000001336'
  const anchorId = '01990000-0000-7000-8000-000000001337'
  const stored = noteRow(noteId, 336)
  await seedHostedNote(stored)
  expect(await apply([{ table: 'hub_note', id: noteId, op: 'delete' }])).toEqual([
    { id: noteId, status: 'applied' },
  ])
  expect(
    await apply([
      {
        table: 'hub_note',
        id: noteId,
        op: 'upsert',
        fields: ['anchors', 'last_seen_at'],
        row: {
          ...stored,
          anchors: JSON.stringify([{ kind: 'run' }, { id: anchorId, kind: 'run' }]),
          sightings: 2,
        },
      },
    ]),
  ).toEqual([
    {
      id: noteId,
      status: 'rejected',
      reason: DELETED_ON_HOSTED_RECORD_REASON,
    },
  ])
})

test('merge appends target anchors before deleting the source and its acknowledgements', async () => {
  const targetId = '01990000-0000-7000-8000-000000001314'
  const sourceId = '01990000-0000-7000-8000-000000001315'
  const acknowledgementId = '01990000-0000-7000-8000-000000001316'
  const targetAnchor = '01990000-0000-7000-8000-000000001317'
  const sourceAnchor = '01990000-0000-7000-8000-000000001318'
  const target = noteRow(targetId, 314, {
    anchors: JSON.stringify([{ id: targetAnchor, kind: 'run' }]),
    sightings: 1,
  })
  const source = noteRow(sourceId, 315, {
    anchors: JSON.stringify([{ id: sourceAnchor, kind: 'run' }]),
    sightings: 1,
  })
  await seedHostedNote(target)
  await seedHostedNote(source)
  await database.query(
    `INSERT INTO hub_note_acknowledgement
      (id,space_id,project_name,note_id,session_id,acknowledged_at,sightings,created_at,updated_at)
     VALUES ($1,$2,'workshop',$3,'session',$4,1,$4,$4)`,
    [acknowledgementId, spaceId, sourceId, '2026-10-09T12:00:00.000Z'],
  )
  const beforeMerge = BigInt(
    (
      await database.query<{ seq: string | number }>(
        `SELECT COALESCE(max(seq),0) seq FROM record_change WHERE space_id=$1`,
        [spaceId],
      )
    ).rows[0]!.seq,
  )
  expect(
    await apply([
      {
        table: 'hub_note',
        id: targetId,
        op: 'upsert',
        fields: ['anchors', 'last_seen_at'],
        row: { ...target, anchors: JSON.stringify([{ id: targetAnchor }, { id: sourceAnchor }]) },
      },
      { table: 'hub_note', id: sourceId, op: 'delete' },
    ]),
  ).toEqual([
    { id: targetId, status: 'applied' },
    { id: sourceId, status: 'applied' },
  ])
  const rows = (
    await database.query<{ id: string; sightings: number; deleted: boolean }>(
      `SELECT id::text,sightings,deleted_at IS NOT NULL deleted FROM hub_note
       WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[targetId, sourceId]],
    )
  ).rows
  expect(rows).toEqual([
    { id: targetId, sightings: 2, deleted: false },
    { id: sourceId, sightings: 1, deleted: true },
  ])
  expect(
    (
      await database.query(
        `SELECT deleted_at IS NOT NULL deleted FROM hub_note_acknowledgement WHERE id=$1`,
        [acknowledgementId],
      )
    ).rows,
  ).toEqual([{ deleted: true }])
  expect(
    (
      await database.query<{ row_id: string }>(
        `SELECT row_id::text FROM record_change WHERE space_id=$1 AND seq>$2
         AND row_id=ANY($3::uuid[]) ORDER BY seq`,
        [spaceId, beforeMerge, [targetId, sourceId, acknowledgementId]],
      )
    ).rows,
  ).toEqual([{ row_id: targetId }, { row_id: sourceId }, { row_id: acknowledgementId }])
})

test('keep adopts the existing hosted acknowledgement id and timestamp comparisons are idempotent', async () => {
  const noteId = '01990000-0000-7000-8000-000000001319'
  const hostedId = '01990000-0000-7000-8000-000000001323'
  const machineId = '01990000-0000-7000-8000-000000001324'
  const hostedAt = '2026-10-09T14:00:00.000Z'
  await seedHostedNote(noteRow(noteId, 319))
  await database.query(
    `INSERT INTO hub_note_acknowledgement
      (id,space_id,project_name,project_id,note_id,session_id,acknowledged_at,sightings,created_at,updated_at)
     VALUES ($1,$2,'workshop',$3,$4,'session',$5,1,$5,$5)`,
    [hostedId, spaceId, projectId, noteId, hostedAt],
  )
  const incoming: PushedNoteAcknowledgement = {
    id: machineId,
    note_id: noteId,
    project_name: 'workshop',
    projectId,
    session_id: 'session',
    acknowledged_at: '2026-10-09T13:00:00.000Z',
    sightings: 1,
    created_at: '2026-10-09T13:00:00.000Z',
    updated_at: '2026-10-09T13:00:00.000Z',
    deleted_at: null,
  }
  const change: ParsedHostedPushChange = {
    table: 'hub_note_acknowledgement',
    id: machineId,
    op: 'upsert',
    row: incoming,
  }
  expect(await apply([change])).toEqual([
    { id: machineId, status: 'duplicate', adoptedId: hostedId },
  ])
  expect(await apply([{ ...change, row: { ...incoming, acknowledged_at: hostedAt } }])).toEqual([
    { id: machineId, status: 'duplicate', adoptedId: hostedId },
  ])
  expect(
    (
      await database.query(
        `SELECT id::text,acknowledged_at FROM hub_note_acknowledgement WHERE note_id=$1`,
        [noteId],
      )
    ).rows,
  ).toEqual([{ id: hostedId, acknowledged_at: new Date(hostedAt) }])
})

test('repeat sighting refuses offline unchanged, then writes the record without an outbox row', async () => {
  const noteId = '01990000-0000-7000-8000-000000001325'
  const initial = noteRow(noteId, 325, {
    anchors: JSON.stringify([{ id: '01990000-0000-7000-8000-000000001326', kind: 'run' }]),
    sightings: 1,
  })
  seedMachineNote(initial)
  await seedHostedNote(initial)
  const input = { text: 'repeat sighting', cwd: '/fixtures/repos/workshop', sameAs: noteId }
  await expect(createNote(input, { hosted: unavailableHosted })).rejects.toThrow(
    'hosted hub unavailable',
  )
  expect(db().query(`SELECT 1 FROM hosted_outbox WHERE row_id=?`).all(noteId)).toHaveLength(0)
  expect(
    db().query<{ sightings: number }, [string]>('SELECT sightings FROM note WHERE record_id=?').get(
      noteId,
    ),
  ).toEqual({ sightings: 1 })
  await createNote(input, { hosted: recordHosted })
  expect(db().query(`SELECT 1 FROM hosted_outbox WHERE row_id=?`).all(noteId)).toHaveLength(0)
  const machine = db()
    .query<{ anchors: string; sightings: number }, [string]>(
      `SELECT anchors,sightings FROM note WHERE record_id=?`,
    )
    .get(noteId)!
  const hosted = (
    await database.query<{ anchors: unknown; sightings: number }>(
      `SELECT anchors,sightings FROM hub_note WHERE id=$1`,
      [noteId],
    )
  ).rows[0]!
  expect({ ...hosted, anchors: JSON.parse(String(hosted.anchors)) }).toEqual({
    anchors: JSON.parse(machine.anchors),
    sightings: machine.sightings,
  })
})

test('a hosted same-sighting write increments the note revision', async () => {
  const noteId = '01990000-0000-7000-8000-000000001326'
  await seedHostedNote(noteRow(noteId, 326))

  const same = await createHostedNote(pgliteSql(database), identity, {
    project: 'workshop',
    projectId,
    text: 'repeat sighting',
    anchor: '{"kind":"run","session_id":"second"}',
    sameAs: noteId,
  })

  expect(same).toMatchObject({ id: noteId, sightings: 2 })
  expect(
    (await database.query(`SELECT revision::int FROM hub_note WHERE id=$1`, [noteId])).rows,
  ).toEqual([{ revision: 2 }])
})

test('keep refuses offline unchanged, then writes the record without an outbox row', async () => {
  const noteId = '01990000-0000-7000-8000-000000001327'
  const initial = noteRow(noteId, 327, { sightings: 1 })
  seedMachineNote(initial)
  await seedHostedNote(initial)
  await expect(
    acknowledgeNote(noteId, 'offline-session', { hosted: unavailableHosted }),
  ).rejects.toThrow('hosted hub unavailable')
  expect(db().query(`SELECT 1 FROM note_acknowledgement`).all()).toHaveLength(0)
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
  await acknowledgeNote(noteId, 'offline-session', { hosted: recordHosted })
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
  expect(
    (
      await database.query(
        `SELECT session_id,sightings FROM hub_note_acknowledgement WHERE note_id=$1`,
        [noteId],
      )
    ).rows,
  ).toEqual([{ session_id: 'offline-session', sightings: 1 }])
})

test('drop refuses offline unchanged, then writes the record without overwriting hosted text', async () => {
  const noteId = '01990000-0000-7000-8000-000000001328'
  const initial = noteRow(noteId, 328, { text: 'machine text' })
  seedMachineNote(initial)
  await seedHostedNote({ ...initial, text: 'hosted edit' })
  await expect(dropNote(noteId, 'offline reason', { hosted: unavailableHosted })).rejects.toThrow(
    'hosted hub unavailable',
  )
  expect(
    db().query(`SELECT stale_at,stale_reason FROM note WHERE record_id=?`).get(noteId),
  ).toEqual({ stale_at: null, stale_reason: null })
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
  await dropNote(noteId, 'offline reason', { hosted: recordHosted })
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
  expect(
    (await database.query(`SELECT text,stale_reason FROM hub_note WHERE id=$1`, [noteId])).rows,
  ).toEqual([{ text: 'hosted edit', stale_reason: 'dropped: offline reason' }])
})

test('merge refuses offline unchanged, then sends target before source with no outbox row', async () => {
  const targetId = '01990000-0000-7000-8000-000000001329'
  const sourceId = '01990000-0000-7000-8000-000000001330'
  const target = noteRow(targetId, 329, {
    anchors: JSON.stringify([{ id: '01990000-0000-7000-8000-000000001331', kind: 'run' }]),
    sightings: 1,
  })
  const source = noteRow(sourceId, 330, {
    anchors: JSON.stringify([{ kind: 'run', run: 12 }]),
    sightings: 1,
  })
  seedMachineNote(target)
  seedMachineNote(source)
  await seedHostedNote(target)
  await seedHostedNote(source)
  await expect(mergeNote(targetId, sourceId, { hosted: unavailableHosted })).rejects.toThrow(
    'hosted hub unavailable',
  )
  expect(db().query(`SELECT 1 FROM note WHERE record_id IN (?,?)`).all(targetId, sourceId)).toHaveLength(2)
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
  const merged = await mergeNote(targetId, sourceId, { hosted: recordHosted })
  expect(merged.anchors).toHaveLength(2)
  expect(merged.anchors[1]?.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
  expect(
    (
      await database.query(
        `SELECT sightings,deleted_at IS NOT NULL deleted FROM hub_note WHERE id=$1`,
        [targetId],
      )
    ).rows,
  ).toEqual([{ sightings: 2, deleted: false }])
  expect(
    (
      await database.query(`SELECT deleted_at IS NOT NULL deleted FROM hub_note WHERE id=$1`, [
        sourceId,
      ])
    ).rows,
  ).toEqual([{ deleted: true }])
})

test('a retried sighting with the same change id does not double-count', async () => {
  const noteId = '01990000-0000-7000-8000-000000001332'
  const changeId = '01990000-0000-7000-8000-000000001333'
  const anchorId = '01990000-0000-7000-8000-000000001334'
  const initial = noteRow(noteId, 332)
  await seedHostedNote(initial)
  const change: HostedPushChange = {
    table: 'hub_note',
    id: noteId,
    op: 'upsert',
    change_id: changeId,
    fields: ['anchors', 'last_seen_at'],
    row: {
      ...initial,
      anchors: JSON.stringify([{ kind: 'run' }, { id: anchorId, kind: 'run' }]),
      sightings: 2,
      last_seen_at: '2026-10-09T11:00:00.000Z',
    },
  }
  const send = () =>
    sendHostedChanges('note workshop#332', [[change]], {
      ...recordHosted,
      conflictRemedy: `${PLATFORM_SLUG} note list --project workshop`,
    })
  await send()
  await send()
  expect(
    (await database.query(`SELECT sightings FROM hub_note WHERE id=$1`, [noteId])).rows,
  ).toEqual([{ sightings: 2 }])
})
