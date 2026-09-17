#!/usr/bin/env bun
import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  deleteIntervals,
  type IntervalEvidence,
  upsertDays,
  upsertIntervals,
} from '../src/hosted-evidence.ts'
import {
  createHostedNote,
  getHostedNote,
  listHostedNotes,
  mirrorHostedNotes,
  promoteHostedNote,
  reapHostedNotes,
} from '../src/hosted-notes.ts'
import {
  createHostedDocument,
  createHostedTask,
  listHostedTasks,
  mirrorHostedTasks,
  patchHostedTask,
  softDeleteHostedDocuments,
} from '../src/hosted-tasks.ts'

const adminUrl = process.env.ORCH_TEST_POSTGRES_URL
const actorUrl = process.env.ORCH_RECORD_URL
if (!adminUrl || !actorUrl) throw new Error('Postgres evidence proof requires test and actor URLs')

const USER = '01990000-0000-7000-8000-000000000650'
const SPACE_A = '01990000-0000-7000-8000-00000000065a'
const SPACE_B = '01990000-0000-7000-8000-00000000065b'
const PROJECT_A = '01990000-0000-7000-8000-00000000065c'
const interval: IntervalEvidence = {
  task_key: 'DEV-655',
  project_name: PLATFORM_SLUG,
  source: 'orch',
  agent: 'codex',
  job: 'implementation',
  start_at: '2026-09-17T12:00:00.000Z',
  end_at: '2026-09-17T12:05:00.000Z',
  claude_tokens: 0,
  vendor_tokens: 100,
  vendor_cost_usd: null,
  ref: 'orch:fixture',
  via: 'prompt',
  open: 0,
  session_id: 'fixture',
}

const admin = new SQL(adminUrl)
try {
  await admin`INSERT INTO "user" (id,email,name,email_verified,created_at,updated_at)
    VALUES (${USER}::uuid,'hub-evidence@example.test','Hub Evidence',true,now(),now())`
  await admin`INSERT INTO space (id,name,slug,created_at) VALUES
    (${SPACE_A}::uuid,'Evidence A','evidence-a',now()),
    (${SPACE_B}::uuid,'Evidence B','evidence-b',now())`
  await admin`INSERT INTO project(id,space_id,name,key_prefixes,created_at)
    VALUES (${PROJECT_A}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},ARRAY['DEV'],now())`

  await upsertIntervals(actorUrl, { userId: USER, spaceId: SPACE_A }, [interval])
  await upsertIntervals(actorUrl, { userId: USER, spaceId: SPACE_A }, [interval])
  await upsertDays(actorUrl, { userId: USER, spaceId: SPACE_A }, [
    {
      day: '2026-09-17',
      claude_tokens: 20,
      cache_read: 0,
      messages: 2,
      tasks: 1,
      canon_tokens: 0,
      other_tokens: 0,
      commits: 1,
      files: 2,
      lines_product: 3,
      lines_test: 4,
      lines_docs: 5,
      lines_config: 6,
      lines_generated: 0,
      collected_at: '2026-09-17T12:06:00.000Z',
    },
  ])

  const client = new SQL(actorUrl)
  try {
    const count = async (spaceId: string, table: string) =>
      client.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${USER}, true)`
        await tx`SELECT set_config('app.space_id', ${spaceId}, true)`
        const rows =
          table === 'hub_interval'
            ? await tx`SELECT count(*)::int AS count FROM hub_interval`
            : await tx`SELECT count(*)::int AS count FROM hub_day`
        return Number(rows[0]!.count)
      })
    if ((await count(SPACE_A, 'hub_interval')) !== 1)
      throw new Error('interval re-push was not a no-op')
    if ((await count(SPACE_A, 'hub_day')) !== 1) throw new Error('day upsert did not land')
    if ((await count(SPACE_B, 'hub_interval')) !== 0 || (await count(SPACE_B, 'hub_day')) !== 0)
      throw new Error('another space observed hosted hub evidence')
    await deleteIntervals(actorUrl, { userId: USER, spaceId: SPACE_A }, [
      { source: interval.source, ref: interval.ref, start_at: interval.start_at },
    ])
    if ((await count(SPACE_A, 'hub_interval')) !== 0)
      throw new Error('vanished interval was not deleted')

    const identity = { userId: USER, spaceId: SPACE_A }
    const stamp = '2026-09-17T12:10:00.000Z'
    const mirrored = {
      id: '01990000-0000-7000-8000-00000000065d',
      key: 'DEV-700',
      project: PLATFORM_SLUG,
      project_name: PLATFORM_SLUG,
      title: 'Mirror fixture',
      status: 'open',
      status_category: 'open',
      parent_key: null,
      body: null,
      assignee: null,
      opened_at: stamp,
      closed_at: null,
      source: 'mcp' as const,
      first_seen: stamp,
      last_seen: stamp,
      created_at: stamp,
      updated_at: stamp,
      deleted_at: null,
    }
    await mirrorHostedTasks(actorUrl, identity, { tasks: [mirrored] })
    await mirrorHostedTasks(actorUrl, identity, { tasks: [mirrored] })
    const created = await createHostedTask(actorUrl, identity, {
      project: PLATFORM_SLUG,
      title: 'Allocated fixture',
    })
    if (created.key !== 'DEV-701') throw new Error(`task allocation returned ${created.key}`)
    await patchHostedTask(actorUrl, identity, created.key, {
      status: 'done',
      status_category: 'done',
    })
    const document = await createHostedDocument(actorUrl, identity, created.key, {
      title: 'Disposable',
      version: 'v1',
    })
    if (!document) throw new Error('task document create did not find its task')
    await softDeleteHostedDocuments(actorUrl, identity, [document.id])
    const visible = await listHostedTasks(actorUrl, identity, {})
    if (visible.tasks.length !== 2) throw new Error('mirror re-push was not idempotent')
    if (visible.documents.some((row) => row.id === document.id))
      throw new Error('soft-deleted document was visible in the default list')
    if (visible.statusEvents.length !== 1)
      throw new Error('status patch did not append exactly one event')
    const other = await listHostedTasks(actorUrl, { userId: USER, spaceId: SPACE_B }, {})
    if (
      other.tasks.length ||
      other.comments.length ||
      other.documents.length ||
      other.statusEvents.length
    )
      throw new Error('another space observed hosted tasks')

    const noteStamp = '2026-09-17T12:20:00.000Z'
    await mirrorHostedNotes(actorUrl, identity, { notes: [{
      id: '01990000-0000-7000-8000-00000000066d', number: 800, project: PLATFORM_SLUG,
      project_name: PLATFORM_SLUG, text: 'Existing note', area: null, anchors: '[]', sightings: 1,
      created_at: noteStamp, last_seen_at: noteStamp, stale_at: null, stale_reason: null,
      promoted_task: null, updated_at: noteStamp, deleted_at: null,
    }], raiseProjects: [{ project: PLATFORM_SLUG, next: 2 }] })
    const allocatedNote = await createHostedNote(actorUrl, identity, {
      project: PLATFORM_SLUG, text: 'Allocated note', anchor: JSON.stringify({ cwd: '/tmp', branch: null,
        commit: null, run_id: null, session_id: null, files: [], project: PLATFORM_SLUG }),
    })
    if (allocatedNote.number !== 801) throw new Error(`note allocation returned ${allocatedNote.number}`)
    await admin`CREATE OR REPLACE FUNCTION fail_hub_task_insert() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION ''forced task insert failure''; END'`
    await admin`CREATE TRIGGER fail_hub_task_insert BEFORE INSERT ON hub_task
      FOR EACH ROW EXECUTE FUNCTION fail_hub_task_insert()`
    let promotionFailed = false
    try { await promoteHostedNote(actorUrl, identity, allocatedNote.number) } catch { promotionFailed = true }
    await admin`DROP TRIGGER fail_hub_task_insert ON hub_task`
    await admin`DROP FUNCTION fail_hub_task_insert()`
    if (!promotionFailed) throw new Error('forced promotion task insert did not fail')
    if ((await getHostedNote(actorUrl, identity, allocatedNote.number))?.promoted_task)
      throw new Error('failed promotion marked its note')
    const promoted = await promoteHostedNote(actorUrl, identity, allocatedNote.number)
    if (!promoted?.task.key || promoted.note.promoted_task !== promoted.task.key)
      throw new Error('promotion did not create a task and mark its note')
    await reapHostedNotes(actorUrl, identity, { stale: [], deleted: [800], confirmation: 1 })
    const visibleNotes = await listHostedNotes(actorUrl, identity, {})
    if (visibleNotes.notes.some((row) => Number(row.number) === 800))
      throw new Error('soft-deleted note was visible in the default list')
    const otherNotes = await listHostedNotes(actorUrl, { userId: USER, spaceId: SPACE_B }, {})
    if (otherNotes.notes.length || otherNotes.acknowledgements.length)
      throw new Error('another space observed hosted notes')
  } finally {
    await client.close()
  }
  console.log('hub postgres evidence and task proof: ok')
} finally {
  await admin`DROP TRIGGER IF EXISTS fail_hub_task_insert ON hub_task`
  await admin`DROP FUNCTION IF EXISTS fail_hub_task_insert()`
  await admin`DELETE FROM hub_note_acknowledgement WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM hub_note WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM hub_task_status_event WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM hub_task_document WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM hub_task_comment WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM hub_task WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM hub_interval WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM hub_day WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM seq WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM project WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM space WHERE id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM "user" WHERE id = ${USER}::uuid`
  await admin.close()
}
