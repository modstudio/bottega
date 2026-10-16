import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { bindTenant } from '../../shared/record/tenant.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { readHostedIdentitySetInTransaction } from './hosted-identity-set.ts'
import { applyHostedPushChangesInTransaction } from './hosted-push-changes.ts'
import { listHostedOutbox, queueHostedChange } from './outbox.ts'
import {
  HOSTED_INTERVAL_TABLE,
  HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
  HOSTED_NOTE_TABLE,
  HOSTED_TASK_TABLE,
  type HostedPushChange,
  PUSHABLE_HUB_CHANGE_TABLES,
  type PushedInterval,
} from './push-contract.ts'
import type { HostedTaskIdentity } from './task-client.ts'
import { formatTaskPushReport, pushTasks } from './task-push.ts'

const spaceA = '01990000-0000-7000-8000-000000008501'
const spaceB = '01990000-0000-7000-8000-000000008502'
const userId = '01990000-0000-7000-8000-000000008500'
const taskA = '01990000-0000-7000-8000-000000008511'
const taskB = '01990000-0000-7000-8000-000000008512'
const missingHosted = '01990000-0000-7000-8000-000000008513'
const hostedOnly = '01990000-0000-7000-8000-000000008514'
const inFlightId = '01990000-0000-7000-8000-000000008515'
const noteId = '01990000-0000-7000-8000-000000008517'
const acknowledgementId = '01990000-0000-7000-8000-000000008518'
const projectA = '01990000-0000-7000-8000-000000008519'
const projectB = '01990000-0000-7000-8000-000000008520'
const pageIds = [
  '01990000-0000-7000-8000-000000008521',
  '01990000-0000-7000-8000-000000008522',
  '01990000-0000-7000-8000-000000008523',
] as const
const at = '2026-10-12T12:00:00.000Z'

const registered = [
  { name: 'workshop', settings: { space: 'one' } },
  { name: 'other', settings: { space: 'two' } },
]
const identity: HostedTaskIdentity = {
  userId,
  activeSpaceId: spaceA,
  memberships: [
    { spaceId: spaceA, slug: 'one', permission: 'write' },
    { spaceId: spaceB, slug: 'two', permission: 'write' },
  ],
  capabilities: {
    spaceIdentitySet: true,
    spacePush: true,
    spacePushTables: [...PUSHABLE_HUB_CHANGE_TABLES],
  },
}

let database: PGlite

const applyOn = (spaceId: string, inputs: HostedPushChange[]) =>
  database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    sql.unsafe = (async (statement: string) =>
      (await transaction.query(statement)).rows) as SQL['unsafe']
    await bindTenant(sql, { userId, spaceId })
    return applyHostedPushChangesInTransaction(sql, { userId, spaceId }, inputs)
  })

const listIds: typeof import('./task-client.ts').hostedIdentitySet = async (
  table,
  options = {},
) => {
  const spaceId = options.recordSpace ?? spaceA
  return database.transaction(async (transaction) => {
    const sql = pgliteSql(transaction as unknown as PGlite)
    await bindTenant(sql, { userId, spaceId })
    return readHostedIdentitySetInTransaction(
      sql,
      { userId, spaceId },
      {
        table,
        after: options.after ?? null,
        limit: 50,
      },
    )
  })
}

function insertMachineTask(id: string, key: string, project: string) {
  const projectId = project === 'workshop' ? projectA : projectB
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO task(record_id,key,project,project_record_id,title,status,status_category,source,first_seen,last_seen)
         VALUES (?,?,?,?,?, 'open','open','local',?,?)`,
      )
      .run(id, key, project, projectId, key, at, at)
  })
}

function hostedTaskRow(id: string, key: string, project: string) {
  return {
    id,
    key,
    project,
    project_name: project,
    projectId: project === 'workshop' ? projectA : projectB,
    title: key,
    status: 'open' as const,
    status_category: 'open' as const,
    parent_key: null,
    body: null,
    assignee: null,
    opened_at: at,
    closed_at: null,
    source: 'local' as const,
    first_seen: at,
    last_seen: at,
    created_at: at,
    updated_at: at,
    deleted_at: null,
    next_document_number: 1,
  }
}

beforeAll(async () => {
  database = await createHostedRecordFixture({ spaceId: spaceA, userId })
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${spaceB}','Push B','push-b',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000008503','${spaceB}','${userId}','member','write',now());
    INSERT INTO project(id,space_id,name,created_at) VALUES
      ('${projectA}','${spaceA}','workshop',now()),
      ('${projectB}','${spaceB}','other',now());
    SET ROLE ${RECORD_ACTOR_ROLE};
  `)
})

beforeEach(async () => {
  resetFixtureStore()
  for (const spaceId of [spaceA, spaceB]) {
    await database.exec(`
      RESET ROLE;
      SET ROLE record_owner;
      SELECT set_config('app.user_id','${userId}',false);
      SELECT set_config('app.space_id','${spaceId}',false);
      SELECT set_config('app.space_ids','${spaceId}',false);
      DELETE FROM hub_task;
      DELETE FROM hub_task_comment;
      DELETE FROM hub_task_document;
      DELETE FROM hub_task_status_event;
      DELETE FROM hub_note_acknowledgement;
      DELETE FROM hub_note;
      DELETE FROM hub_interval;
      DELETE FROM hub_day;
    `)
  }

  await database.exec(`
    RESET ROLE;
    SET ROLE ${RECORD_ACTOR_ROLE};
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceA}',false);
    SELECT set_config('app.space_ids','${spaceA}',false);
  `)
})

function insertMachineNote(id: string) {
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO note
          (record_id,number,project,project_record_id,text,anchors,sightings,created_at,last_seen_at)
         VALUES (?,1,'workshop',?,'note','[]',1,?,?)`,
      )
      .run(id, projectA, at, at)
  })
}

function insertMachineAcknowledgement(id: string, selectedNoteId = noteId) {
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO note_acknowledgement
          (record_id,note_record_id,session_id,acknowledged_at,sightings)
         VALUES (?,?,'session',?,1)`,
      )
      .run(id, selectedNoteId, at)
  })
}

async function insertHostedNote(id: string) {
  await database.query(
    `INSERT INTO hub_note
      (id,space_id,project_name,project_id,number,project,text,anchors,sightings,created_at,last_seen_at,
       updated_at)
     VALUES ($1,$2,'workshop',$3,1,'workshop','note','[]',1,$4,$4,$4)`,
    [id, spaceA, projectA, at],
  )
}

async function insertHostedAcknowledgement(id: string, selectedNoteId = noteId) {
  await database.query(
    `INSERT INTO hub_note_acknowledgement
      (id,space_id,project_name,project_id,note_id,session_id,acknowledged_at,sightings,created_at,updated_at)
     VALUES ($1,$2,'workshop',$3,$4,'session',$5,1,$5,$5)`,
    [id, spaceA, projectA, selectedNoteId, at],
  )
}

afterAll(async () => {
  if (database) await database.close()
})

const runPush = (repair = false) =>
  pushTasks({
    repair,
    identity: async () => identity,
    listIds,
    registered: () => registered,
    drain: async (dependencies) => {
      const { drainHostedOutbox } = await import('./outbox.ts')
      return drainHostedOutbox({
        ...dependencies,
        identity: async () => identity,
        registered: () => registered,
        push: async (changes, options) => applyOn(options.recordSpace ?? spaceA, changes),
      })
    },
  })

test('task push reports nothing missing when the sides agree', async () => {
  insertMachineTask(taskA, 'DEV-1', 'workshop')
  await applyOn(spaceA, [
    {
      table: HOSTED_TASK_TABLE,
      id: taskA,
      op: 'upsert',
      row: hostedTaskRow(taskA, 'DEV-1', 'workshop'),
    },
  ])
  const report = await runPush()
  const tasks = report.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(tasks).toMatchObject({ both: 1, machineOnly: [], hostedOnly: [], inFlight: [] })
  expect(report.ok).toBeTrue()
  expect(report.drain).toBeNull()
})

test('note and acknowledgement rows that agree are counted under both', async () => {
  insertMachineNote(noteId)
  insertMachineAcknowledgement(acknowledgementId)
  await insertHostedNote(noteId)
  await insertHostedAcknowledgement(acknowledgementId)
  const report = await runPush()
  const tables = report.spaces.find((space) => space.spaceId === spaceA)?.tables
  expect(tables?.find((table) => table.table === HOSTED_NOTE_TABLE)).toMatchObject({
    both: 1,
    machineOnly: [],
    hostedOnly: [],
  })
  expect(tables?.find((table) => table.table === HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE)).toMatchObject({
    both: 1,
    machineOnly: [],
    hostedOnly: [],
  })
  expect(report.ok).toBeTrue()
})

test('a machine-only note is reported as unrepairable and repair queues nothing for it', async () => {
  insertMachineNote(noteId)
  const report = await runPush(true)
  expect(report.unrepairable).toEqual([
    {
      table: HOSTED_NOTE_TABLE,
      id: noteId,
      reason: 'the hosted record assigns note numbers, so a missing note cannot be created by push',
      remedy: `inspect with \`${PLATFORM_SLUG} note list --json\` and find record_id ${noteId}. The machine has no command to create a note the hosted record lacks, so the choice is to file it again or drop the machine copy. Dropping the machine copy currently queues an update that the hosted record can only reject.`,
    },
  ])
  expect(report.drain?.queued).toBe(0)
  expect(listHostedOutbox()).toEqual([])
  expect(formatTaskPushReport(report)).toContain(
    `unrepairable ${HOSTED_NOTE_TABLE} ${noteId} the hosted record assigns note numbers, so a missing note cannot be created by push\n` +
      `  remedy: inspect with \`${PLATFORM_SLUG} note list --json\` and find record_id ${noteId}. The machine has no command to create a note the hosted record lacks, so the choice is to file it again or drop the machine copy. Dropping the machine copy currently queues an update that the hosted record can only reject.`,
  )
  expect(report.ok).toBeFalse()
})

test('a machine-only acknowledgement is queued and restored by repair', async () => {
  insertMachineNote(noteId)
  insertMachineAcknowledgement(acknowledgementId)
  await insertHostedNote(noteId)
  const report = await runPush(true)
  expect(report.drain?.sent).toBe(1)
  expect(report.unrepairable).toEqual([])
  expect(listHostedOutbox()).toEqual([])
  expect((await listIds(HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE)).ids).toContain(acknowledgementId)
  expect(report.ok).toBeTrue()
})

test('a hosted delete is only-on-machine and --repair restores it through the outbox', async () => {
  insertMachineTask(missingHosted, 'DEV-miss', 'workshop')
  const before = await runPush()
  const tasks = before.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(tasks?.machineOnly).toEqual([missingHosted])
  expect(listHostedOutbox()).toEqual([])
  const repaired = await runPush(true)
  expect(listHostedOutbox()).toEqual([])
  expect(repaired.drain?.sent).toBe(1)
  const after = await listIds(HOSTED_TASK_TABLE, { recordSpace: spaceA })
  expect(after.ids).toContain(missingHosted)
})

test('a row only on the hosted record is reported and not touched', async () => {
  await applyOn(spaceA, [
    {
      table: HOSTED_TASK_TABLE,
      id: hostedOnly,
      op: 'upsert',
      row: hostedTaskRow(hostedOnly, 'DEV-host', 'workshop'),
    },
  ])
  const before = (
    await database.query<{ count: number }>(
      `SELECT count(*)::int count FROM hub_task WHERE id=$1`,
      [hostedOnly],
    )
  ).rows[0]!.count
  const report = await runPush(true)
  const tasks = report.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(tasks?.hostedOnly).toEqual([hostedOnly])
  expect(report.ok).toBeFalse()
  expect(
    (
      await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM hub_task WHERE id=$1`,
        [hostedOnly],
      )
    ).rows[0]!.count,
  ).toBe(before)
  expect(formatTaskPushReport(report)).toContain('The machine has no command to fetch them yet.')
  expect(formatTaskPushReport(report)).not.toContain(`${PLATFORM_SLUG} record pull`)
})

test('a pending outbox entry is in flight not missing', async () => {
  insertMachineTask(inFlightId, 'DEV-fly', 'workshop')
  writeTransaction((conn) => queueHostedChange(conn, HOSTED_TASK_TABLE, inFlightId, 'upsert'))
  const report = await runPush()
  const tasks = report.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(tasks?.inFlight).toEqual([inFlightId])
  expect(tasks?.machineOnly).toEqual([])
})

test('task push follows more than one identity-set page', async () => {
  const calls: Array<string | null | undefined> = []
  const report = await pushTasks({
    identity: async () => identity,
    registered: () => registered,
    listIds: async (table, options = {}) => {
      if (table !== HOSTED_TASK_TABLE || options.recordSpace !== spaceA)
        return { ids: [], more: false }
      calls.push(options.after)
      if (!options.after) return { ids: [pageIds[0], pageIds[1]], more: true }
      return { ids: [pageIds[2]], more: false }
    },
  })
  expect(calls).toEqual([null, pageIds[1]])
  const tasks = report.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(tasks?.hostedOnly).toEqual([...pageIds])
})

test("a second space's rows are not counted against the first", async () => {
  insertMachineTask(taskA, 'DEV-1', 'workshop')
  insertMachineTask(taskB, 'OTH-1', 'other')
  await applyOn(spaceA, [
    {
      table: HOSTED_TASK_TABLE,
      id: taskA,
      op: 'upsert',
      row: hostedTaskRow(taskA, 'DEV-1', 'workshop'),
    },
  ])
  await applyOn(spaceB, [
    {
      table: HOSTED_TASK_TABLE,
      id: taskB,
      op: 'upsert',
      row: hostedTaskRow(taskB, 'OTH-1', 'other'),
    },
  ])
  const report = await runPush()
  const first = report.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  const second = report.spaces
    .find((space) => space.spaceId === spaceB)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(first).toMatchObject({ both: 1, machineOnly: [], hostedOnly: [] })
  expect(second).toMatchObject({ both: 1, machineOnly: [], hostedOnly: [] })
  expect(first?.machineOnly).not.toContain(taskB)
  expect(second?.machineOnly).not.toContain(taskA)
})

test('without --repair nothing is written', async () => {
  insertMachineTask(missingHosted, 'DEV-miss', 'workshop')
  const report = await runPush(false)
  expect(report.drain).toBeNull()
  expect(listHostedOutbox()).toEqual([])
  const hosted = await listIds(HOSTED_TASK_TABLE, { recordSpace: spaceA })
  expect(hosted.ids).not.toContain(missingHosted)
})

test('task push refuses a hub that does not advertise spaceIdentitySet', async () => {
  await expect(
    pushTasks({
      identity: async () => ({ ...identity, capabilities: {} }),
      listIds: async () => ({ ids: [], more: false }),
      registered: () => registered,
    }),
  ).rejects.toThrow('hosted hub does not advertise space identity set support')
})

const intervalRow = (id: string): PushedInterval => ({
  id,
  task_key: null,
  project_name: 'workshop',
  projectId: projectA,
  source: 'orch',
  agent: null,
  job: null,
  start_at: at,
  end_at: at,
  claude_tokens: 0,
  vendor_tokens: 0,
  vendor_cost_usd: null,
  ref: 'orch:8514',
  via: null,
  open: 0,
  session_id: null,
  user_id: null,
})

test('hosted-only interval rows are a count, not a failure, and are not listed by id', async () => {
  await applyOn(spaceA, [
    { table: HOSTED_INTERVAL_TABLE, id: hostedOnly, op: 'upsert', row: intervalRow(hostedOnly) },
  ])
  const report = await runPush()
  const intervals = report.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_INTERVAL_TABLE)
  expect(intervals).toMatchObject({ pulled: false, hostedOnly: [hostedOnly], machineOnly: [] })
  expect(report.ok).toBeTrue()
  const text = formatTaskPushReport(report)
  expect(text).toContain('written by another machine or no longer held here')
  expect(text).not.toContain(`    ${hostedOnly}`)
})

test('repair insert-if-absent keeps a hosted title written after the audit', async () => {
  insertMachineTask(missingHosted, 'DEV-miss', 'workshop')
  const outcomes: Array<{ id: string; status: string }> = []
  const repaired = await pushTasks({
    repair: true,
    identity: async () => identity,
    listIds,
    registered: () => registered,
    drain: async (dependencies) => {
      await applyOn(spaceA, [
        {
          table: HOSTED_TASK_TABLE,
          id: missingHosted,
          op: 'upsert',
          row: { ...hostedTaskRow(missingHosted, 'DEV-miss', 'workshop'), title: 'Hosted title' },
        },
      ])
      const { drainHostedOutbox } = await import('./outbox.ts')
      return drainHostedOutbox({
        ...dependencies,
        identity: async () => identity,
        registered: () => registered,
        push: async (changes, options) => {
          const result = await applyOn(options.recordSpace ?? spaceA, changes)
          outcomes.push(...result)
          return result
        },
      })
    },
  })
  expect(outcomes).toEqual([{ id: missingHosted, status: 'duplicate' }])
  expect(repaired.ok).toBeTrue()
  expect(
    (
      await database.query<{ title: string }>(`SELECT title FROM hub_task WHERE id=$1`, [
        missingHosted,
      ])
    ).rows[0]!.title,
  ).toBe('Hosted title')
})

test('a quarantined outbox entry is stuck, not in flight, and fails', async () => {
  insertMachineTask(inFlightId, 'DEV-fly', 'workshop')
  writeTransaction((conn) => {
    queueHostedChange(conn, HOSTED_TASK_TABLE, inFlightId, 'upsert')
    conn
      .query(`UPDATE hosted_outbox SET quarantined_at=?, quarantine_reason=? WHERE row_id=?`)
      .run(at, 'conflict', inFlightId)
  })
  const report = await runPush()
  const tasks = report.spaces
    .find((space) => space.spaceId === spaceA)
    ?.tables.find((table) => table.table === HOSTED_TASK_TABLE)
  expect(tasks?.inFlight).toEqual([])
  expect(tasks?.machineOnly).toEqual([])
  expect(report.stuck).toEqual([{ table: HOSTED_TASK_TABLE, id: inFlightId, reason: 'conflict' }])
  expect(report.ok).toBeFalse()
  expect(formatTaskPushReport(report)).toContain(`${PLATFORM_SLUG} record outbox`)
})

test('repair fails when the drain rejects a queued row', async () => {
  insertMachineTask(missingHosted, 'DEV-miss', 'workshop')
  const report = await pushTasks({
    repair: true,
    identity: async () => identity,
    listIds,
    registered: () => registered,
    drain: async () => ({
      queued: 1,
      sent: 0,
      rejected: 1,
      quarantined: 0,
      dropped: 0,
      waitingOnRouting: {},
      skippedCapability: false,
    }),
  })
  expect(report.ok).toBeFalse()
  expect(formatTaskPushReport(report)).toContain('repair drain rejected rows')
})

test('--repair with an unroutable project reports the refusal and queues nothing', async () => {
  const ghost = '01990000-0000-7000-8000-000000008516'
  insertMachineTask(ghost, 'GHO-1', 'ghost')
  const report = await runPush(true)
  expect(report.unroutable).toEqual([
    {
      project: 'ghost',
      reason: 'unregistered-project',
      table: HOSTED_TASK_TABLE,
      ids: [ghost],
    },
  ])
  expect(report.ok).toBeFalse()
  expect(listHostedOutbox()).toEqual([])
  const hosted = await listIds(HOSTED_TASK_TABLE, { recordSpace: spaceA })
  expect(hosted.ids).not.toContain(ghost)
  expect(formatTaskPushReport(report)).toContain(ghost)
})
