#!/usr/bin/env bun
import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { bindTenant } from '../../shared/record/tenant.ts'
import {
  deleteIntervals,
  type IntervalEvidence,
  upsertDays,
  upsertIntervals,
} from '../src/hosted-evidence.ts'
import { hostedMeasures, loadHostedMeasureRows } from '../src/hosted-measures.ts'
import {
  createHostedNote,
  getHostedNote,
  listHostedNotes,
  mirrorHostedNotes,
  promoteHostedNote,
  reapHostedNotes,
} from '../src/hosted-notes.ts'
import { hostedGatherReport } from '../src/hosted-report-gather.ts'
import {
  appendHostedSend,
  createHostedReportSubscription,
  hostedEmailRecipientByToken,
  listHostedReportSubscriptions,
  listHostedSends,
  unsubscribeHostedEmailRecipient,
  unsubscribeHostedReportSubscription,
  updateHostedReportSubscription,
} from '../src/hosted-reports.ts'
import { hostedTaskPresence, softDeleteHostedTasks } from '../src/hosted-task-prune.ts'
import {
  createHostedDocument,
  createHostedTask,
  listHostedTasks,
  mirrorHostedTasks,
  patchHostedTask,
  softDeleteHostedDocuments,
} from '../src/hosted-tasks.ts'
import {
  hostedFlightDone,
  hostedNotes,
  hostedRatio,
  hostedSettings,
  hostedSpend,
  hostedTaskDetail,
} from '../src/hosted-work.ts'
import { computeMeasures } from '../src/measures.ts'
import {
  hostedDeliveryRepository,
  sendHostedReportSubscriptionTest,
} from '../src/report-delivery-hosted.ts'

const adminUrl = process.env.ORCH_TEST_POSTGRES_URL
const actorUrl = process.env.ORCH_RECORD_URL
if (!adminUrl || !actorUrl) throw new Error('Postgres evidence proof requires test and actor URLs')

const USER = '01990000-0000-7000-8000-000000000650'
const SECOND_USER = '01990000-0000-7000-8000-000000000651'
const SPACE_A = '01990000-0000-7000-8000-00000000065a'
const SPACE_B = '01990000-0000-7000-8000-00000000065b'
const SPACE_C = '01990000-0000-7000-8000-00000000066b'
const PROJECT_A = '01990000-0000-7000-8000-00000000065c'
const PROJECT_B = '01990000-0000-7000-8000-00000000066c'
const PROJECT_MOVE = '01990000-0000-7000-8000-00000000067c'
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
  user_id: null,
}

const admin = new SQL(adminUrl)
try {
  await admin`INSERT INTO "user" (id,email,name,email_verified,created_at,updated_at)
    VALUES (${USER}::uuid,'hub-evidence@example.test','Hub Evidence',true,now(),now()),
      (${SECOND_USER}::uuid,'hub-second@example.test','Hub Second',true,now(),now())`
  await admin`INSERT INTO space (id,name,slug,created_at) VALUES
    (${SPACE_A}::uuid,'Evidence A','evidence-a',now()),
    (${SPACE_B}::uuid,'Evidence B','evidence-b',now()),
    (${SPACE_C}::uuid,'Evidence C','evidence-c',now())`
  await admin`INSERT INTO project(id,space_id,name,key_prefixes,created_at)
    VALUES (${PROJECT_A}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},ARRAY['DEV'],now()),
      (${PROJECT_B}::uuid,${SPACE_B}::uuid,${PLATFORM_SLUG},ARRAY['DEV'],now()),
      (${PROJECT_MOVE}::uuid,${SPACE_B}::uuid,'move-proof',ARRAY['MOVE'],now())`
  await admin`INSERT INTO membership(id,space_id,user_id,role,permission,created_at)
    VALUES (${newRecordId()}::uuid,${SPACE_A}::uuid,${USER}::uuid,'member','write',now()),
      (${newRecordId()}::uuid,${SPACE_B}::uuid,${USER}::uuid,'member','write',now()),
      (${newRecordId()}::uuid,${SPACE_C}::uuid,${USER}::uuid,'owner','write',now()),
      (${newRecordId()}::uuid,${SPACE_A}::uuid,${SECOND_USER}::uuid,'member','write',now())`

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
    const crossSpaceProjects = await client.begin(async (tx) => {
      await bindTenant(tx, { userId: USER, spaceId: SPACE_A, spaceIds: [SPACE_A, SPACE_B] })
      return tx`SELECT id FROM project WHERE id IN (${PROJECT_A}::uuid,${PROJECT_B}::uuid)`
    })
    if (crossSpaceProjects.length !== 2)
      throw new Error('app.space_ids did not admit a two-space project read')
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
    await upsertIntervals(actorUrl, identity, [
      { ...interval, task_key: created.key, ref: 'orch:hosted-view-fixture', user_id: USER },
    ])
    const hostedDone = await hostedFlightDone(actorUrl, identity, {
      name: 'done',
      hours: 720,
      filters: { agent: '', project: '', source: '' },
      projects: [{ name: PLATFORM_SLUG, keyPrefixes: ['DEV'] }],
    })
    if (!hostedDone.data.rows.some((row) => row.key === created.key && row.runs.length === 1))
      throw new Error('hosted done adapter did not return the seeded task and interval')
    const detail = await hostedTaskDetail(actorUrl, identity, created.key)
    if (detail?.statusHistory.length !== 1 || detail.intervals.length !== 1)
      throw new Error('hosted task detail did not return status history and intervals')

    const legacyCommentId = '01990000-0000-7000-8000-000000000680'
    const legacyDocumentId = '01990000-0000-7000-8000-000000000681'
    const legacyEventId = '01990000-0000-7000-8000-000000000682'
    const legacyChildId = '01990000-0000-7000-8000-000000000683'
    const legacyNoteId = '01990000-0000-7000-8000-000000000684'
    await admin`INSERT INTO hub_task_comment
      (id,space_id,project_name,task_key,body,created_at,updated_at) VALUES
      (${legacyCommentId}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${mirrored.key},'legacy',${stamp}::timestamptz,${stamp}::timestamptz)`
    await admin`INSERT INTO hub_task_document
      (id,space_id,project_name,task_key,title,body,version,created_at,updated_at) VALUES
      (${legacyDocumentId}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${mirrored.key},'legacy','legacy','v1',${stamp}::timestamptz,${stamp}::timestamptz)`
    await admin`INSERT INTO hub_task_status_event
      (id,space_id,project_name,task_key,at,from_status,to_status,created_at,updated_at) VALUES
      (${legacyEventId}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${mirrored.key},${stamp}::timestamptz,NULL,'open',${stamp}::timestamptz,${stamp}::timestamptz)`
    await admin`INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,status,status_category,parent_key,source,
       first_seen,last_seen,created_at,updated_at) VALUES
      (${legacyChildId}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},'DEV-LEGACY-CHILD',${PLATFORM_SLUG},
       'legacy child','open','open',${mirrored.key},'mcp',${stamp}::timestamptz,${stamp}::timestamptz,
       ${stamp}::timestamptz,${stamp}::timestamptz)`
    await admin`INSERT INTO hub_note
      (id,space_id,project_name,number,project,text,anchors,sightings,created_at,last_seen_at,
       promoted_task,updated_at) VALUES
      (${legacyNoteId}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},799,${PLATFORM_SLUG},'legacy note','[]',1,
       ${stamp}::timestamptz,${stamp}::timestamptz,${mirrored.key},${stamp}::timestamptz)`

    const renamed = {
      ...mirrored,
      key: 'DEV-702',
      updated_at: '2026-09-17T12:11:00.000Z',
      last_seen: '2026-09-17T12:11:00.000Z',
    }
    await mirrorHostedTasks(actorUrl, identity, { tasks: [renamed] })
    const repaired = await admin`
      SELECT 'comment' kind,task_key key,task_id id FROM hub_task_comment WHERE id=${legacyCommentId}::uuid
      UNION ALL SELECT 'document',task_key,task_id FROM hub_task_document WHERE id=${legacyDocumentId}::uuid
      UNION ALL SELECT 'event',task_key,task_id FROM hub_task_status_event WHERE id=${legacyEventId}::uuid
      UNION ALL SELECT 'child',parent_key,parent_id FROM hub_task WHERE id=${legacyChildId}::uuid
      UNION ALL SELECT 'note',promoted_task,promoted_task_id FROM hub_note WHERE id=${legacyNoteId}::uuid
      ORDER BY kind`
    if (
      repaired.length !== 5 ||
      repaired.some((row) => row.key !== renamed.key || row.id !== mirrored.id)
    )
      throw new Error('task rename did not repair all five legacy hosted relationships')

    const holderId = '01990000-0000-7000-8000-000000000685'
    const incomingId = '01990000-0000-7000-8000-000000000686'
    await admin`INSERT INTO hub_task_status_event
      (id,legacy_local_id,space_id,project_name,task_key,at,from_status,to_status,created_at,updated_at)
      VALUES (${holderId}::uuid,77,${SPACE_A}::uuid,${PLATFORM_SLUG},${renamed.key},
        ${'2026-09-17T12:12:00.000Z'}::timestamptz,'open','active',
        ${'2026-09-17T12:12:00.000Z'}::timestamptz,${'2026-09-17T12:12:00.000Z'}::timestamptz)`
    const adopted = await mirrorHostedTasks(actorUrl, identity, {
      tasks: [],
      statusEvents: [
        {
          id: incomingId,
          legacy_local_id: 77,
          newly_assigned: true,
          task_key: renamed.key,
          task_id: mirrored.id,
          project_name: PLATFORM_SLUG,
          at: '2026-09-17T12:12:00.000Z',
          from_status: 'open',
          to_status: 'active',
          created_at: '2026-09-17T12:12:00.000Z',
          updated_at: '2026-09-17T12:12:00.000Z',
          deleted_at: null,
        },
      ],
    })
    const adoptedHolder = await admin`SELECT task_key,task_id FROM hub_task_status_event
      WHERE id=${holderId}::uuid`
    if (
      adopted.adoptions[0]?.id !== holderId ||
      adoptedHolder[0]?.task_key !== renamed.key ||
      adoptedHolder[0]?.task_id !== mirrored.id
    )
      throw new Error('status-event adoption did not resolve the legacy holder task id')

    const collectorEventId = '01990000-0000-7000-8000-000000000687'
    const pushedEventId = '01990000-0000-7000-8000-000000000688'
    const naturalEventAt = '2026-09-17T12:13:00.000Z'
    await mirrorHostedTasks(actorUrl, identity, {
      tasks: [],
      statusEvents: [
        {
          id: collectorEventId,
          legacy_local_id: null,
          task_key: renamed.key,
          task_id: null,
          project_name: PLATFORM_SLUG,
          at: naturalEventAt,
          from_status: 'open',
          to_status: 'active',
          created_at: naturalEventAt,
          updated_at: naturalEventAt,
          deleted_at: null,
        },
      ],
    })
    const naturalAdoption = await mirrorHostedTasks(actorUrl, identity, {
      tasks: [],
      statusEvents: [
        {
          id: pushedEventId,
          legacy_local_id: 78,
          newly_assigned: false,
          task_key: renamed.key,
          task_id: mirrored.id,
          project_name: PLATFORM_SLUG,
          at: naturalEventAt,
          from_status: 'backlog',
          to_status: 'active',
          created_at: naturalEventAt,
          updated_at: naturalEventAt,
          deleted_at: null,
        },
      ],
    })
    const naturalHolder = await admin`SELECT id,legacy_local_id,task_id,from_status
      FROM hub_task_status_event
      WHERE space_id=${SPACE_A}::uuid AND task_key=${renamed.key}
        AND to_status='active' AND at=${naturalEventAt}::timestamptz`
    if (
      naturalAdoption.adoptions[0]?.table !== 'task_status_event' ||
      naturalAdoption.adoptions[0]?.id !== collectorEventId ||
      naturalAdoption.adoptions[0]?.legacy_local_id !== 78 ||
      naturalHolder.length !== 1 ||
      naturalHolder[0]?.id !== collectorEventId ||
      Number(naturalHolder[0]?.legacy_local_id) !== 78 ||
      naturalHolder[0]?.task_id !== mirrored.id ||
      naturalHolder[0]?.from_status !== 'open'
    )
      throw new Error('status-event natural-key holder was not adopted without insertion')

    if (await hostedTaskDetail(actorUrl, { userId: USER, spaceId: SPACE_B }, created.key))
      throw new Error('another space observed hosted task detail')
    const other = await listHostedTasks(actorUrl, { userId: USER, spaceId: SPACE_B }, {})
    if (
      other.tasks.length ||
      other.comments.length ||
      other.documents.length ||
      other.statusEvents.length
    )
      throw new Error('another space observed hosted tasks')

    const noteStamp = '2026-09-17T12:20:00.000Z'
    await mirrorHostedNotes(actorUrl, identity, {
      notes: [
        {
          id: '01990000-0000-7000-8000-00000000066d',
          number: 800,
          project: PLATFORM_SLUG,
          project_name: PLATFORM_SLUG,
          text: 'Existing note',
          area: null,
          anchors: '[]',
          sightings: 1,
          created_at: noteStamp,
          last_seen_at: noteStamp,
          stale_at: noteStamp,
          stale_reason: 'gone',
          promoted_task: null,
          updated_at: noteStamp,
          deleted_at: null,
        },
      ],
      raiseProjects: [{ project: PLATFORM_SLUG, next: 2 }],
    })
    const allocatedNote = await createHostedNote(actorUrl, identity, {
      project: PLATFORM_SLUG,
      text: 'Allocated note',
      anchor: JSON.stringify({
        cwd: '/tmp',
        branch: null,
        commit: null,
        run_id: null,
        session_id: null,
        files: [],
        project: PLATFORM_SLUG,
      }),
    })
    if (allocatedNote.number !== 801)
      throw new Error(`note allocation returned ${allocatedNote.number}`)
    await admin`CREATE OR REPLACE FUNCTION fail_hub_task_insert() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION ''forced task insert failure''; END'`
    await admin`CREATE TRIGGER fail_hub_task_insert BEFORE INSERT ON hub_task
      FOR EACH ROW EXECUTE FUNCTION fail_hub_task_insert()`
    let promotionFailed = false
    try {
      await promoteHostedNote(actorUrl, identity, allocatedNote.number)
    } catch {
      promotionFailed = true
    }
    await admin`DROP TRIGGER fail_hub_task_insert ON hub_task`
    await admin`DROP FUNCTION fail_hub_task_insert()`
    if (!promotionFailed) throw new Error('forced promotion task insert did not fail')
    if ((await getHostedNote(actorUrl, identity, allocatedNote.number))?.promoted_task)
      throw new Error('failed promotion marked its note')
    const promoted = await promoteHostedNote(actorUrl, identity, allocatedNote.number)
    if (!promoted?.task.key || promoted.note.promoted_task !== promoted.task.key)
      throw new Error('promotion did not create a task and mark its note')
    await mirrorHostedNotes(actorUrl, identity, {
      notes: [
        {
          id: '01990000-0000-7000-8000-00000000066e',
          number: 802,
          project: PLATFORM_SLUG,
          project_name: PLATFORM_SLUG,
          text: 'Re-sighted note',
          area: null,
          anchors: '[]',
          sightings: 2,
          created_at: noteStamp,
          last_seen_at: noteStamp,
          stale_at: noteStamp,
          stale_reason: 'gone',
          promoted_task: null,
          updated_at: noteStamp,
          deleted_at: null,
        },
      ],
    })
    const cutoff = noteStamp
    let refusedResighted = false
    try {
      await reapHostedNotes(actorUrl, identity, {
        stale: [],
        deleted: [802],
        confirmation: 1,
        cutoff,
      })
    } catch (error) {
      if (!String((error as Error).message).includes('local cache is behind the record'))
        throw error
      refusedResighted = true
    }
    if (!refusedResighted) throw new Error('reap of a re-sighted note was not refused')
    if (!(await getHostedNote(actorUrl, identity, 802)))
      throw new Error('re-sighted note was deleted')
    await reapHostedNotes(actorUrl, identity, {
      stale: [],
      deleted: [800],
      confirmation: 1,
      cutoff,
    })
    const visibleNotes = await listHostedNotes(actorUrl, identity, {})
    if (visibleNotes.notes.some((row) => Number(row.number) === 800))
      throw new Error('soft-deleted note was visible in the default list')
    const otherNotes = await listHostedNotes(actorUrl, { userId: USER, spaceId: SPACE_B }, {})
    if (otherNotes.notes.length || otherNotes.acknowledgements.length)
      throw new Error('another space observed hosted notes')

    await appendHostedSend(actorUrl, identity, {
      at: '2026-09-17T15:30:00.000Z',
      window: '24h',
      recipients: 'recipient@example.test',
      projects: PLATFORM_SLUG,
      items: 3,
      status: 'sent',
      error: null,
      test: 0,
      machine: 'fixture-machine',
    })
    const visibleSends = await listHostedSends(actorUrl, identity, {})
    if (visibleSends.sends.length !== 1 || visibleSends.sends[0]?.items !== 3)
      throw new Error('appended send was not visible in the list')
    const otherIdentity = { userId: USER, spaceId: SPACE_B }
    if ((await listHostedSends(actorUrl, otherIdentity, {})).sends.length)
      throw new Error('another space observed send history')
    const recipientColumns =
      await admin`SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='hub_report_subscription_recipient'
        AND column_name IN ('user_id','email','unsubscribe_token') ORDER BY column_name`
    if (
      recipientColumns.length !== 3 ||
      recipientColumns.some((column) => column.is_nullable !== 'YES')
    )
      throw new Error('report email recipient columns did not migrate as nullable')
    const projectSubscriptionColumns =
      await admin`SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='hub_report_subscription_project'
      ORDER BY column_name`
    if (
      ![
        'id',
        'space_id',
        'subscription_id',
        'project_id',
        'project_space_id',
        'project_name',
        'created_at',
      ].every((name) =>
        projectSubscriptionColumns.some(
          (column) => column.column_name === name && column.is_nullable === 'NO',
        ),
      )
    )
      throw new Error('report subscription project table or snapshot columns did not migrate')
    const recipientKindCheck = await admin`SELECT pg_get_constraintdef(oid) definition
      FROM pg_constraint WHERE conname='hub_report_subscription_recipient_kind_check'`
    if (
      recipientKindCheck.length !== 1 ||
      !String(recipientKindCheck[0]?.definition).includes('unsubscribe_token')
    )
      throw new Error('report recipient kind CHECK was not installed')
    let nonMemberRefused = false
    try {
      await createHostedReportSubscription(actorUrl, identity, {
        scope: { kind: 'space' },
        cadence: 'daily',
        hour: 8,
        zone: 'America/New_York',
        recipientUserIds: ['01990000-0000-7000-8000-000000000699'],
      })
    } catch (error) {
      nonMemberRefused = String((error as Error).message).includes('must be a member')
    }
    if (!nonMemberRefused) throw new Error('a non-member report recipient was accepted')
    let memberEmailRefused = false
    try {
      await createHostedReportSubscription(actorUrl, identity, {
        scope: { kind: 'space' },
        cadence: 'daily',
        hour: 8,
        zone: 'America/New_York',
        recipientUserIds: [],
        recipientEmails: ['outside@example.test'],
      })
    } catch (error) {
      memberEmailRefused = String((error as Error).message).includes('owner or admin')
    }
    if (!memberEmailRefused) throw new Error('a member added an email report recipient')
    await admin`UPDATE membership SET role='owner' WHERE space_id=${SPACE_A}::uuid AND user_id=${USER}::uuid`
    await admin`UPDATE membership SET role='admin' WHERE space_id=${SPACE_B}::uuid AND user_id=${USER}::uuid`
    await admin`UPDATE "user" SET personal_space_id=${SPACE_A}::uuid WHERE id=${USER}::uuid`
    const projectsSubscription = await createHostedReportSubscription(
      actorUrl,
      { userId: USER, spaceId: SPACE_A, spaceIds: [SPACE_A, SPACE_B] },
      {
        scope: { kind: 'projects', projectIds: [PROJECT_A, PROJECT_B] },
        cadence: 'daily',
        hour: 8,
        zone: 'America/New_York',
        recipientUserIds: [USER],
      },
    )
    if (projectsSubscription.projects.length !== 2)
      throw new Error('projects subscription did not retain both chosen project ids')
    const movedProjectSubscription = await createHostedReportSubscription(
      actorUrl,
      { userId: USER, spaceId: SPACE_A, spaceIds: [SPACE_A, SPACE_B, SPACE_C] },
      {
        scope: { kind: 'projects', projectIds: [PROJECT_MOVE] },
        cadence: 'daily',
        hour: 8,
        zone: 'America/New_York',
        recipientUserIds: [USER],
      },
    )
    // Preview and confirm run in separate transactions, as record-space-move.ts does.
    const moveTenant = { userId: USER, spaceId: SPACE_B, spaceIds: [SPACE_A, SPACE_B, SPACE_C] }
    const preview = (await client.begin(async (tx) => {
      await bindTenant(tx, moveTenant)
      return tx`SELECT * FROM record_move_project_space('evidence-b','move-proof','evidence-c')`
    })) as { row_count: number }[]
    const total = preview.reduce((sum, row) => sum + Number(row.row_count), 0)
    const moveRows = await client.begin(async (tx) => {
      await bindTenant(tx, moveTenant)
      return tx`SELECT * FROM record_move_project_space(
        'evidence-b','move-proof','evidence-c',${total}::bigint)`
    })
    const selectionMove = moveRows.find(
      (row) => row.table_name === 'hub_report_subscription_project',
    )
    if (
      !selectionMove?.moved ||
      selectionMove.reached_by !== 'report selection; space reference updated, ownership kept'
    )
      throw new Error('project move did not report the report-selection reference update')
    const movedSelection = (
      await admin`SELECT space_id,project_space_id FROM hub_report_subscription_project
        WHERE subscription_id=${movedProjectSubscription.id}::uuid`
    )[0]
    if (movedSelection?.space_id !== SPACE_A || movedSelection.project_space_id !== SPACE_C)
      throw new Error(
        'project move changed selection ownership or missed its current-space reference',
      )
    const movedCandidate = {
      subscriptionId: movedProjectSubscription.id,
      spaceId: SPACE_A,
      cadence: 'daily' as const,
      hour: 8,
      weekday: null,
      zone: 'America/New_York',
      createdAt: movedProjectSubscription.created_at,
      lastPeriodEnd: null,
    }
    const deliveryPeriod = {
      from: '2026-09-17T00:00:00.000Z',
      to: '2026-09-18T00:00:00.000Z',
      key: '2026-09-18T00:00:00.000Z',
    }
    const movedDelivery = await hostedDeliveryRepository(actorUrl).load(
      movedCandidate,
      deliveryPeriod,
    )
    if (
      movedDelivery.scope.kind !== 'projects' ||
      !movedDelivery.scope.projectIds.includes(PROJECT_MOVE)
    )
      throw new Error('delivery did not resolve a moved project in its destination space')
    await admin`UPDATE membership SET role='member'
      WHERE space_id=${SPACE_C}::uuid AND user_id=${USER}::uuid`
    const movedDemotedDelivery = await hostedDeliveryRepository(actorUrl).load(
      movedCandidate,
      deliveryPeriod,
    )
    if (
      movedDemotedDelivery.scope.kind !== 'projects' ||
      movedDemotedDelivery.scope.projectIds.length !== 0 ||
      !movedDemotedDelivery.exclusions?.some(
        (line) => line.includes('move-proof') && line.includes('owner or admin'),
      )
    )
      throw new Error('moved project was not excluded with its named owner/admin reason')
    let unavailableTestSends = 0
    const unavailableTest = await sendHostedReportSubscriptionTest(
      actorUrl,
      identity,
      movedProjectSubscription.id,
      {
        now: new Date('2026-09-18T12:00:00.000Z'),
        mail: {
          async send() {
            unavailableTestSends++
          },
        },
      },
    )
    if (
      unavailableTest.status !== 'skipped' ||
      unavailableTestSends !== 0 ||
      !unavailableTest.message.includes('owner or admin')
    )
      throw new Error('test send did not skip an unavailable projects subscription with a message')
    await admin`UPDATE membership SET role='member' WHERE space_id=${SPACE_B}::uuid AND user_id=${USER}::uuid`
    const demotedDelivery = await hostedDeliveryRepository(actorUrl).load(
      {
        subscriptionId: projectsSubscription.id,
        spaceId: SPACE_A,
        cadence: 'daily',
        hour: 8,
        weekday: null,
        zone: 'America/New_York',
        createdAt: projectsSubscription.created_at,
        lastPeriodEnd: null,
      },
      {
        from: '2026-09-17T00:00:00.000Z',
        to: '2026-09-18T00:00:00.000Z',
        key: '2026-09-18T00:00:00.000Z',
      },
    )
    if (
      demotedDelivery.scope.kind !== 'projects' ||
      demotedDelivery.scope.projectIds.join() !== PROJECT_A ||
      !demotedDelivery.exclusions?.some(
        (line) => line.includes(PLATFORM_SLUG) && line.includes('owner or admin'),
      )
    )
      throw new Error('demoted project was not excluded with its snapshotted name and reason')
    let partialTestSends = 0
    const partialTest = await sendHostedReportSubscriptionTest(
      actorUrl,
      identity,
      projectsSubscription.id,
      {
        now: new Date('2026-09-18T12:00:00.000Z'),
        mail: {
          async send() {
            partialTestSends++
          },
        },
      },
    )
    const partialTestRow = (
      await admin`SELECT status,error FROM hub_send WHERE id=${partialTest.id}::uuid`
    )[0]
    if (
      partialTest.status !== 'sent' ||
      partialTestSends !== 1 ||
      partialTestRow?.status !== 'sent' ||
      !String(partialTestRow.error).includes('owner or admin')
    )
      throw new Error('test send did not send and record its excluded projects')
    await unsubscribeHostedReportSubscription(actorUrl, identity, projectsSubscription.id)
    await unsubscribeHostedReportSubscription(actorUrl, identity, movedProjectSubscription.id)
    const emailSubscription = await createHostedReportSubscription(actorUrl, identity, {
      scope: { kind: 'space' },
      cadence: 'daily',
      hour: 8,
      zone: 'America/New_York',
      recipientUserIds: [USER],
      recipientEmails: [' First@Example.Test ', 'second@example.test'],
    })
    const deliveryRepository = hostedDeliveryRepository(actorUrl)
    const deliveryCandidate = (await deliveryRepository.discover()).find(
      (candidate) => candidate.subscriptionId === emailSubscription.id,
    )
    if (!deliveryCandidate) throw new Error('email subscription was not a delivery candidate')
    if (!(await deliveryRepository.recipientsAreMembers(deliveryCandidate, [USER])))
      throw new Error('single-member delivery recipient membership check failed')
    const memberReport = await hostedGatherReport(
      actorUrl,
      identity,
      { from: interval.start_at, to: interval.end_at },
      { kind: 'members', userIds: [USER] },
    )
    if (!memberReport.items.some((item) => item.key === created.key))
      throw new Error('single-member report scope did not gather the member interval')
    const emailRows =
      await admin`SELECT email,unsubscribe_token FROM hub_report_subscription_recipient
      WHERE subscription_id=${emailSubscription.id}::uuid ORDER BY email NULLS FIRST`
    if (
      emailRows.length !== 3 ||
      emailRows[1]?.email !== 'first@example.test' ||
      !emailRows[1]?.unsubscribe_token
    )
      throw new Error('email report recipients were not normalized or tokenized')
    const emailDetail = await hostedEmailRecipientByToken(
      actorUrl,
      SPACE_A,
      emailRows[1]!.unsubscribe_token,
    )
    if (emailDetail?.email !== 'first@example.test' || emailDetail.space !== 'Evidence A')
      throw new Error('public report unsubscribe detail was not available by token')
    if (
      (await hostedEmailRecipientByToken(actorUrl, SPACE_B, emailRows[1]!.unsubscribe_token)) !==
      null
    )
      throw new Error('public report unsubscribe detail crossed its bound space')
    if (await unsubscribeHostedEmailRecipient(actorUrl, SPACE_B, emailRows[1]!.unsubscribe_token))
      throw new Error('public report unsubscribe deleted through the wrong bound space')
    if (
      !(await unsubscribeHostedEmailRecipient(actorUrl, SPACE_A, emailRows[1]!.unsubscribe_token))
    )
      throw new Error('public report unsubscribe did not remove its email row')
    const remainingEmailRecipients =
      await admin`SELECT user_id,email FROM hub_report_subscription_recipient
      WHERE subscription_id=${emailSubscription.id}::uuid`
    if (remainingEmailRecipients.length !== 2)
      throw new Error('unsubscribing an email recipient removed another recipient')
    await updateHostedReportSubscription(actorUrl, identity, emailSubscription.id, {
      scope: { kind: 'space' },
      cadence: 'daily',
      hour: 8,
      zone: 'America/New_York',
      recipientUserIds: [USER],
      recipientEmails: ['second@example.test'],
      enabled: true,
    })
    const singleEmailRecipients =
      await admin`SELECT user_id,email FROM hub_report_subscription_recipient
      WHERE subscription_id=${emailSubscription.id}::uuid ORDER BY email NULLS FIRST`
    if (
      singleEmailRecipients.length !== 2 ||
      singleEmailRecipients[0]?.user_id !== USER ||
      singleEmailRecipients[1]?.email !== 'second@example.test'
    )
      throw new Error('subscription update did not keep exactly one email recipient')
    await updateHostedReportSubscription(actorUrl, identity, emailSubscription.id, {
      scope: { kind: 'space' },
      cadence: 'daily',
      hour: 8,
      zone: 'America/New_York',
      recipientUserIds: [USER],
      recipientEmails: [],
      enabled: true,
    })
    const memberOnlyRecipients =
      await admin`SELECT user_id,email FROM hub_report_subscription_recipient
      WHERE subscription_id=${emailSubscription.id}::uuid`
    if (
      memberOnlyRecipients.length !== 1 ||
      memberOnlyRecipients[0]?.user_id !== USER ||
      memberOnlyRecipients[0]?.email !== null
    )
      throw new Error('updating a subscription to member-only recipients kept an email row')
    await unsubscribeHostedReportSubscription(actorUrl, identity, emailSubscription.id)
    const subscription = await createHostedReportSubscription(actorUrl, identity, {
      scope: { kind: 'project', project: PLATFORM_SLUG },
      cadence: 'weekly',
      hour: 8,
      weekday: 'monday',
      zone: 'America/New_York',
      recipientUserIds: [USER, SECOND_USER],
    })
    if (
      subscription.zone !== 'America/New_York' ||
      subscription.cadence !== 'weekly' ||
      subscription.weekday !== 'monday' ||
      subscription.hour !== 8
    )
      throw new Error('subscription cadence did not round-trip with its zone')
    if (subscription.recipients.length !== 2)
      throw new Error('subscription did not list every selected member')
    await admin`UPDATE hub_send SET subscription_id=${subscription.id}::uuid,
      period_start=${'2026-09-10T15:30:00.000Z'}::timestamptz,
      period_end=${'2026-09-17T15:30:00.000Z'}::timestamptz
      WHERE space_id=${SPACE_A}::uuid AND at=${'2026-09-17T15:30:00.000Z'}::timestamptz`
    const historicalSend = await admin`SELECT id FROM hub_send
      WHERE subscription_id=${subscription.id}::uuid`
    await admin`INSERT INTO hub_send_recipient
      (id,space_id,send_id,user_id,name,email,created_at) VALUES
      (${newRecordId()}::uuid,${SPACE_A}::uuid,${historicalSend[0]!.id}::uuid,
       ${SECOND_USER}::uuid,'Hub Second','hub-second@example.test',now())`
    await updateHostedReportSubscription(actorUrl, identity, subscription.id, {
      scope: { kind: 'project', project: PLATFORM_SLUG },
      cadence: 'weekly',
      hour: 8,
      weekday: 'monday',
      zone: 'America/New_York',
      recipientUserIds: [USER],
      enabled: true,
    })
    const afterOneRemoval = await listHostedReportSubscriptions(actorUrl, identity)
    if (
      afterOneRemoval.subscriptions[0]?.recipients.length !== 1 ||
      afterOneRemoval.subscriptions[0]?.recipients[0]?.user_id !== USER
    )
      throw new Error('subscription recipients were not removed independently')
    const preservedRecipient = await admin`SELECT user_id FROM hub_send_recipient
      WHERE send_id=${historicalSend[0]!.id}::uuid`
    if (preservedRecipient[0]?.user_id !== SECOND_USER)
      throw new Error('removing a recipient rewrote an existing send row')
    const updatedSubscription = await updateHostedReportSubscription(
      actorUrl,
      identity,
      subscription.id,
      {
        scope: { kind: 'members', userIds: [USER, SECOND_USER] },
        cadence: 'daily',
        hour: 18,
        zone: 'America/New_York',
        recipientUserIds: [USER, SECOND_USER],
        enabled: true,
      },
    )
    if (
      updatedSubscription.hour !== 18 ||
      updatedSubscription.cadence !== 'daily' ||
      updatedSubscription.members.length !== 2 ||
      updatedSubscription.recipients.length !== 2
    )
      throw new Error('subscription update did not replace its scope, recipients and schedule')
    const preservedSend = await admin`SELECT subscription_id,period_end FROM hub_send
      WHERE subscription_id=${subscription.id}::uuid`
    if (preservedSend.length !== 1)
      throw new Error('subscription update did not preserve the record of what was sent')
    await admin`INSERT INTO hub_send
      (id,space_id,at,"window",recipients,projects,items,status,error,test,created_at,machine,
       subscription_id,period_start,period_end)
      VALUES (${newRecordId()}::uuid,${SPACE_A}::uuid,now(),'test','hub@example.test','subscription',
      0,'sent',NULL,1,now(),'test',${subscription.id}::uuid,
      ${'2029-12-31T00:00:00.000Z'}::timestamptz,${'2030-01-01T00:00:00.000Z'}::timestamptz)`
    const afterTestSend = (await client`SELECT last_period_end FROM hub_report_delivery_candidates()
      WHERE subscription_id=${subscription.id}::uuid`) as {
      last_period_end: string | Date | null
    }[]
    if (new Date(afterTestSend[0]!.last_period_end!).toISOString() !== '2026-09-17T15:30:00.000Z')
      throw new Error('a test send advanced the subscription schedule')
    const visibleSubscriptions = await listHostedReportSubscriptions(actorUrl, identity)
    if (
      visibleSubscriptions.subscriptions.length !== 1 ||
      visibleSubscriptions.subscriptions[0]?.id !== subscription.id
    )
      throw new Error('created subscription was not visible in the list')
    if ((await listHostedReportSubscriptions(actorUrl, otherIdentity)).subscriptions.length)
      throw new Error('another space observed an updated report subscription')
    for (const operation of [
      () =>
        updateHostedReportSubscription(actorUrl, otherIdentity, subscription.id, {
          scope: { kind: 'space' },
          cadence: 'daily',
          hour: 7,
          zone: 'America/New_York',
          recipientUserIds: [USER],
          enabled: true,
        }),
      () => unsubscribeHostedReportSubscription(actorUrl, otherIdentity, subscription.id),
    ]) {
      let refused = false
      try {
        await operation()
      } catch (error) {
        refused = String((error as Error).message).includes('report subscription not found')
      }
      if (!refused) throw new Error('another space changed a report subscription')
    }
    const unboundSubscriptions = await client`SELECT id FROM hub_report_subscription`
    if (unboundSubscriptions.length !== 0)
      throw new Error('record_actor directly observed subscriptions without a tenant binding')
    const deliveryCandidates = (await client`SELECT subscription_id,space_id
      FROM hub_report_delivery_candidates()`) as { subscription_id: string; space_id: string }[]
    if (
      !deliveryCandidates.some(
        (row) => row.subscription_id === subscription.id && row.space_id === SPACE_A,
      )
    )
      throw new Error('delivery discovery function did not return the enabled subscription')

    const pageNotes = await hostedNotes(actorUrl, identity, { stale: false })
    if (!pageNotes.notes.some((row) => row.id === allocatedNote.number))
      throw new Error('hosted notes page adapter did not return the seeded note')
    const pageRatio = await hostedRatio(actorUrl, identity, 14)
    if (!pageRatio.days.some((row) => row.day === '2026-09-17'))
      throw new Error('hosted ratio adapter did not return the seeded day')
    const pageSpend = await hostedSpend(actorUrl, identity, 14)
    if (!pageSpend.numerators.some((row) => row.name === 'codex'))
      throw new Error('hosted spend adapter did not return the seeded interval')
    const pageSettings = await hostedSettings(actorUrl, identity, [PLATFORM_SLUG])
    if (
      // Two sends of this space's subscription, plus the projects-scope skipped and partial test sends.
      pageSettings.sends.length !== 4 ||
      pageSettings.sends.filter((send) => Number(send.test) === 1).length !== 3 ||
      pageSettings.members.length !== 2 ||
      pageSettings.subscriptions.length !== 1
    )
      throw new Error('hosted settings adapter did not return members, sends and subscriptions')
    const emptyNotes = await hostedNotes(actorUrl, otherIdentity, { stale: false })
    const emptyRatio = await hostedRatio(actorUrl, otherIdentity, 14)
    const emptySettings = await hostedSettings(actorUrl, otherIdentity, [])
    if (
      emptyNotes.notes.length ||
      emptyRatio.days.length ||
      emptySettings.sends.length ||
      emptySettings.subscriptions.length
    )
      throw new Error('another space observed a hosted page adapter row')

    await unsubscribeHostedReportSubscription(actorUrl, identity, subscription.id)
    if ((await listHostedReportSubscriptions(actorUrl, identity)).subscriptions.length)
      throw new Error('removed subscription remained visible in its space')
    const candidatesAfterRemove = (await client`SELECT subscription_id
      FROM hub_report_delivery_candidates()`) as { subscription_id: string }[]
    if (candidatesAfterRemove.some((row) => row.subscription_id === subscription.id))
      throw new Error('removed subscription remained due for delivery')

    const measureWindow = { from: '2026-09-17T12:00:00.000Z', to: '2026-09-17T14:00:00.000Z' }
    const measureIntervals: IntervalEvidence[] = [
      {
        task_key: 'DEV-758',
        project_name: PLATFORM_SLUG,
        source: 'orch',
        agent: 'grok',
        job: 'implement',
        start_at: '2026-09-17T12:00:00.000Z',
        end_at: '2026-09-17T13:00:00.000Z',
        claude_tokens: 0,
        vendor_tokens: 10,
        vendor_cost_usd: 0.2,
        ref: 'orch:measures-a',
        via: 'prompt',
        open: 0,
        session_id: 'maya',
        user_id: USER,
      },
      {
        task_key: 'DEV-758',
        project_name: PLATFORM_SLUG,
        source: 'orch',
        agent: 'codex',
        job: 'implement',
        start_at: '2026-09-17T12:30:00.000Z',
        end_at: '2026-09-17T13:30:00.000Z',
        claude_tokens: 0,
        vendor_tokens: 5,
        vendor_cost_usd: 0.1,
        ref: 'orch:measures-b',
        via: 'prompt',
        open: 0,
        session_id: 'maya',
        user_id: USER,
      },
      {
        task_key: 'DEV-758',
        project_name: PLATFORM_SLUG,
        source: 'claude',
        agent: null,
        job: null,
        start_at: '2026-09-17T12:00:00.000Z',
        end_at: '2026-09-17T13:00:00.000Z',
        claude_tokens: 20,
        vendor_tokens: 0,
        vendor_cost_usd: null,
        ref: 'claude:measures-maya',
        via: 'prompt',
        open: 0,
        session_id: 'maya',
        user_id: USER,
      },
      {
        task_key: null,
        project_name: PLATFORM_SLUG,
        source: 'claude',
        agent: null,
        job: null,
        start_at: '2026-09-17T12:00:00.000Z',
        end_at: '2026-09-17T13:00:00.000Z',
        claude_tokens: 20,
        vendor_tokens: 0,
        vendor_cost_usd: null,
        ref: 'claude:measures-unknown',
        via: 'prompt',
        open: 0,
        session_id: 'anon',
        user_id: null,
      },
    ]
    await upsertIntervals(actorUrl, identity, measureIntervals)
    await mirrorHostedTasks(actorUrl, identity, {
      tasks: [
        {
          id: '01990000-0000-7000-8000-000000000758',
          key: 'DEV-758',
          project: PLATFORM_SLUG,
          project_name: PLATFORM_SLUG,
          title: 'Measures',
          status: 'done',
          status_category: 'done',
          parent_key: null,
          body: null,
          assignee: null,
          opened_at: '2026-09-17T10:00:00.000Z',
          closed_at: '2026-09-17T12:50:00.000Z',
          source: 'mcp',
          first_seen: '2026-09-17T10:00:00.000Z',
          last_seen: '2026-09-17T12:50:00.000Z',
          created_at: '2026-09-17T10:00:00.000Z',
          updated_at: '2026-09-17T12:50:00.000Z',
          deleted_at: null,
        },
      ],
    })
    const doneAt = '2026-09-17T12:10:00.000Z'
    await admin`INSERT INTO hub_task_status_event
      (id,space_id,project_name,task_key,at,from_status,to_status,created_at,updated_at)
      VALUES
        (${newRecordId()}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},'DEV-758',
          ${doneAt}::timestamptz,'open','done',${doneAt}::timestamptz,${doneAt}::timestamptz),
        (${newRecordId()}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},'DEV-758',
          ${'2026-09-17T12:50:00.000Z'}::timestamptz,'open','done',
          ${'2026-09-17T12:50:00.000Z'}::timestamptz,${'2026-09-17T12:50:00.000Z'}::timestamptz)`
    const loaded = await loadHostedMeasureRows(actorUrl, identity, measureWindow)
    const pure = computeMeasures(loaded, measureWindow, { kind: 'space' })
    const hosted = await hostedMeasures(actorUrl, identity, measureWindow, { kind: 'space' })
    if (JSON.stringify(pure) !== JSON.stringify(hosted))
      throw new Error('hosted measures differed from the pure function on the same rows')
    if (hosted.hoursRunning.unionMs !== 90 * 60_000)
      throw new Error(
        `hosted hours running merged overlapping orch as ${hosted.hoursRunning.unionMs}`,
      )
    if (hosted.agentHours.sumMs <= hosted.hoursRunning.unionMs)
      throw new Error('hosted agent-hours did not keep overlapping orch spans')
    if (hosted.scope === 'person' || hosted.shipped.count !== 1)
      throw new Error('shipped counted a task more than once after two done entries')
    const otherMeasures = await hostedMeasures(actorUrl, otherIdentity, measureWindow, {
      kind: 'space',
    })
    if (
      otherMeasures.hoursRunning.unionMs !== 0 ||
      otherMeasures.agentHours.sumMs !== 0 ||
      otherMeasures.sessionTime.unionThenSumMs !== 0 ||
      otherMeasures.scope === 'person' ||
      otherMeasures.shipped.count !== 0
    )
      throw new Error('another space observed hosted measures')

    const pruneId = '01990000-0000-7000-8000-000000000760'
    const guardId = '01990000-0000-7000-8000-000000000761'
    const parentHolderId = '01990000-0000-7000-8000-000000000762'
    const pruneKey = 'DEV-760'
    await admin`INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,status,status_category,source,
       first_seen,last_seen,created_at,updated_at) VALUES
      (${pruneId}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${pruneKey},${PLATFORM_SLUG},
       'prune','open','open','mcp',${stamp}::timestamptz,${stamp}::timestamptz,
       ${stamp}::timestamptz,${stamp}::timestamptz),
      (${guardId}::uuid,${SPACE_B}::uuid,${PLATFORM_SLUG},${pruneKey},${PLATFORM_SLUG},
       'guard','open','open','mcp',${stamp}::timestamptz,${stamp}::timestamptz,
       ${stamp}::timestamptz,${stamp}::timestamptz),
      (${parentHolderId}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},'DEV-762',${PLATFORM_SLUG},
       'child','open','open','mcp',${stamp}::timestamptz,${stamp}::timestamptz,
       ${stamp}::timestamptz,${stamp}::timestamptz)`
    await admin`UPDATE hub_task SET parent_key=${pruneKey},parent_id=${pruneId}::uuid
      WHERE id=${parentHolderId}::uuid`
    await admin`INSERT INTO hub_task_comment
      (id,space_id,project_name,task_key,task_id,body,created_at,updated_at) VALUES
      (${newRecordId()}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${pruneKey},${pruneId}::uuid,
       'by id',${stamp}::timestamptz,${stamp}::timestamptz)`
    await admin`INSERT INTO hub_task_document
      (id,space_id,project_name,task_key,title,body,version,created_at,updated_at) VALUES
      (${newRecordId()}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${pruneKey},'by key','body','v1',
       ${stamp}::timestamptz,${stamp}::timestamptz)`
    await admin`INSERT INTO hub_task_status_event
      (id,space_id,project_name,task_key,at,from_status,to_status,created_at,updated_at) VALUES
      (${newRecordId()}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${pruneKey},${stamp}::timestamptz,
       NULL,'open',${stamp}::timestamptz,${stamp}::timestamptz)`
    await admin`INSERT INTO hub_note
      (id,space_id,project_name,number,project,text,anchors,sightings,created_at,last_seen_at,
       promoted_task,promoted_task_id,updated_at) VALUES
      (${newRecordId()}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},760,${PLATFORM_SLUG},'prune link',
       '[]',1,${stamp}::timestamptz,${stamp}::timestamptz,${pruneKey},${pruneId}::uuid,
       ${stamp}::timestamptz)`
    const membershipIdentity = {
      userId: USER,
      spaceId: SPACE_A,
      spaceIds: [SPACE_A, SPACE_B],
    }
    const presence = await hostedTaskPresence(actorUrl, membershipIdentity, [
      { space_id: SPACE_B, key: pruneKey },
      { space_id: '01990000-0000-7000-8000-000000000699', key: pruneKey },
    ])
    if (presence.present.length !== 1 || presence.refused[0]?.reason !== 'not-a-member')
      throw new Error('task presence did not distinguish member and non-member spaces')
    await softDeleteHostedTasks(actorUrl, membershipIdentity, [pruneId]).then(
      () => {
        throw new Error('one-task prune accepted missing confirmation')
      },
      (error) => {
        if (!(error instanceof Error) || !error.message.includes('confirmation count 1'))
          throw error
      },
    )
    await softDeleteHostedTasks(actorUrl, membershipIdentity, [pruneId], 0).then(
      () => {
        throw new Error('one-task prune accepted mismatched confirmation')
      },
      (error) => {
        if (!(error instanceof Error) || !error.message.includes('confirmation count 1'))
          throw error
      },
    )
    const deleted = await softDeleteHostedTasks(actorUrl, membershipIdentity, [pruneId, guardId], 1)
    if (
      deleted.tasks !== 1 ||
      deleted.comments !== 1 ||
      deleted.documents !== 1 ||
      deleted.statusEvents !== 1
    )
      throw new Error(`task prune returned wrong table counts: ${JSON.stringify(deleted)}`)
    const pruneEvidence = await admin`
      SELECT
        (SELECT deleted_at IS NOT NULL FROM hub_task WHERE id=${pruneId}::uuid) task_deleted,
        (SELECT deleted_at IS NULL FROM hub_task WHERE id=${guardId}::uuid) guard_active,
        (SELECT parent_id IS NULL FROM hub_task WHERE id=${parentHolderId}::uuid) parent_cleared,
        (SELECT promoted_task_id IS NULL FROM hub_note WHERE number=760 AND space_id=${SPACE_A}::uuid) promotion_cleared,
        (SELECT count(*)::int FROM hub_task_comment WHERE space_id=${SPACE_A}::uuid AND task_key=${pruneKey} AND deleted_at IS NOT NULL) comments,
        (SELECT count(*)::int FROM hub_task_document WHERE space_id=${SPACE_A}::uuid AND task_key=${pruneKey} AND deleted_at IS NOT NULL) documents,
        (SELECT count(*)::int FROM hub_task_status_event WHERE space_id=${SPACE_A}::uuid AND task_key=${pruneKey} AND deleted_at IS NOT NULL) events`
    const proof = pruneEvidence[0]!
    if (
      !proof.task_deleted ||
      !proof.guard_active ||
      !proof.parent_cleared ||
      !proof.promotion_cleared ||
      Number(proof.comments) !== 1 ||
      Number(proof.documents) !== 1 ||
      Number(proof.events) !== 1
    )
      throw new Error(`task prune Postgres evidence failed: ${JSON.stringify(proof)}`)
  } finally {
    await client.close()
  }
  console.log('hub postgres evidence and task proof: ok')
} finally {
  await admin`DROP TRIGGER IF EXISTS fail_hub_task_insert ON hub_task`
  await admin`DROP FUNCTION IF EXISTS fail_hub_task_insert()`
  await admin`DELETE FROM hub_note_acknowledgement WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_note WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_send_recipient WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_send WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_report_subscription_member WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_report_subscription_project WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_report_subscription_recipient WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_report_subscription WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM membership WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_task_status_event WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_task_document WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_task_comment WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_task WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_interval WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM hub_day WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM seq WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM project WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM space WHERE id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM "user" WHERE id IN (${USER}::uuid, ${SECOND_USER}::uuid)`
  await admin.close()
}
