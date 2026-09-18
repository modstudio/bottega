#!/usr/bin/env bun
import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record/schema.ts'
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
import {
  appendHostedSend,
  createHostedReportSubscription,
  getHostedReportSetting,
  listHostedReportSubscriptions,
  listHostedSends,
  putHostedReportSetting,
} from '../src/hosted-reports.ts'
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
  user_id: null,
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
  await admin`INSERT INTO membership(id,space_id,user_id,role,permission,created_at)
    VALUES (${newRecordId()}::uuid,${SPACE_A}::uuid,${USER}::uuid,'member','write',now())`

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
    await upsertIntervals(actorUrl, identity, [
      { ...interval, task_key: created.key, ref: 'orch:hosted-view-fixture' },
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

    const reportValue = {
      enabled: true,
      to: ['recipient@example.test'],
      fromName: 'Daily Report',
      fromAddress: 'sender@example.test',
      subjectPrefix: 'Daily',
      smtpHost: 'smtp.example.test',
      smtpPort: 587,
      smtpUser: 'sender',
      smtpPasswordRef: 'env:SMTP_PASSWORD',
      windowHours: 24,
      minMinutes: 15,
      projects: [PLATFORM_SLUG, 'not-in-this-space'],
      briefs: [],
      testTo: 'test@example.test',
    }
    const reportSetting = await putHostedReportSetting(actorUrl, identity, {
      value: reportValue,
      version: 0,
    })
    if (reportSetting.version !== 1 || reportSetting.value.projects.join(',') !== PLATFORM_SLUG)
      throw new Error('report setting upsert did not filter projects or advance its version')
    let versionConflict = false
    try {
      await putHostedReportSetting(actorUrl, identity, { value: reportValue, version: 0 })
    } catch (error) {
      versionConflict = String((error as Error).message).includes('stale report setting version')
    }
    if (!versionConflict) throw new Error('stale report setting version was not refused')
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
    if (await getHostedReportSetting(actorUrl, otherIdentity))
      throw new Error('another space observed the report setting')
    if ((await listHostedSends(actorUrl, otherIdentity, {})).sends.length)
      throw new Error('another space observed send history')
    const subscription = await createHostedReportSubscription(actorUrl, identity, {
      scope: { kind: 'project', project: PLATFORM_SLUG },
      cadence: 'weekly',
      hour: 8,
      weekday: 'monday',
      zone: 'America/New_York',
    })
    if (
      subscription.zone !== 'America/New_York' ||
      subscription.cadence !== 'weekly' ||
      subscription.weekday !== 'monday' ||
      subscription.hour !== 8
    )
      throw new Error('subscription cadence did not round-trip with its zone')
    const visibleSubscriptions = await listHostedReportSubscriptions(actorUrl, identity)
    if (
      visibleSubscriptions.subscriptions.length !== 1 ||
      visibleSubscriptions.subscriptions[0]?.id !== subscription.id
    )
      throw new Error('created subscription was not visible in the list')
    if ((await listHostedReportSubscriptions(actorUrl, otherIdentity)).subscriptions.length)
      throw new Error('another space observed a report subscription')

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
      !pageSettings.report.enabled ||
      pageSettings.sends.length !== 1 ||
      pageSettings.subscriptions.length !== 1
    )
      throw new Error('hosted settings adapter did not return the setting, send and subscription')
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
  } finally {
    await client.close()
  }
  console.log('hub postgres evidence and task proof: ok')
} finally {
  await admin`DROP TRIGGER IF EXISTS fail_hub_task_insert ON hub_task`
  await admin`DROP FUNCTION IF EXISTS fail_hub_task_insert()`
  await admin`DELETE FROM hub_note_acknowledgement WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM hub_note WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM hub_send WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM hub_report_setting WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM hub_report_subscription WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
  await admin`DELETE FROM membership WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid)`
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
