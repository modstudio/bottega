#!/usr/bin/env bun
import { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { OUTSIDE_WRITES_PER_HOUR } from '../../shared/outside-write-decision.ts'
import { readRecordChanges } from '../../shared/record/record-changes.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { RECORD_CHANGE_LOGGED_TABLES } from '../../shared/record/schema-record-change.ts'
import {
  RECORD_SERVICE_IDLE_IN_TRANSACTION_TIMEOUT,
  RECORD_SERVICE_STATEMENT_TIMEOUT,
  recordServiceUrl,
} from '../../shared/record/service-connection.ts'
import { bindTenant } from '../../shared/record/tenant.ts'
import type { IntervalEvidence } from '../src/hosted-evidence.ts'
import { hostedMeasures, loadHostedMeasureRows } from '../src/hosted-measures.ts'
import { listHostedNotes } from '../src/hosted-note-list.ts'
import {
  createHostedNote,
  getHostedNote,
  mirrorHostedNotes,
  promoteHostedNote,
  reapHostedNotes,
} from '../src/hosted-notes.ts'
import { applyHostedPushChanges } from '../src/hosted-push-changes.ts'
import { readHostedRecordChanges } from '../src/hosted-record-changes.ts'
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
import { listHostedTasks } from '../src/hosted-task-list.ts'
import { hostedTaskPresence, softDeleteHostedTasks } from '../src/hosted-task-prune.ts'
import { createHostedDocument, createHostedTask, type HostedTask } from '../src/hosted-tasks.ts'
import {
  hostedFlightDone,
  hostedNotes,
  hostedRatio,
  hostedSettings,
  hostedSpend,
  hostedTaskDetail,
} from '../src/hosted-work.ts'
import { computeMeasures } from '../src/measures.ts'
import { noteApi } from '../src/note-api.ts'
import type { OperatorWaitingEmailInput } from '../src/operator-waiting-email-contract.ts'
import {
  OPERATOR_EMAIL_HOURLY_BUDGET,
  OPERATOR_EMAIL_MAX_ATTEMPTS,
  OperatorEmailBudgetExceededError,
  sendOperatorWaitingEmail,
} from '../src/operator-waiting-email-hosted.ts'
import type { HostedPushChange, PushedDay } from '../src/push-contract.ts'
import {
  hostedDeliveryRepository,
  sendHostedReportSubscriptionTest,
} from '../src/report-delivery-hosted.ts'

const adminUrl = process.env.BOTTEGA_TEST_POSTGRES_URL
const actorDatabaseUrl = process.env.BOTTEGA_RECORD_URL
if (!adminUrl || !actorDatabaseUrl)
  throw new Error('Postgres evidence proof requires test and actor URLs')
const actorUrl = new SQL(actorDatabaseUrl)
const boundedActorUrl = new SQL(recordServiceUrl(actorDatabaseUrl), { max: 1 })

const USER = '01990000-0000-7000-8000-000000000650'
const SECOND_USER = '01990000-0000-7000-8000-000000000651'
const READ_USER = '01990000-0000-7000-8000-000000000652'
const OUTSIDE_USER = '01990000-0000-7000-8000-000000000653'
const OTHER_OUTSIDE_USER = '01990000-0000-7000-8000-000000000654'
const OWNER_USER = '01990000-0000-7000-8000-000000000655'
const SPACE_A = '01990000-0000-7000-8000-00000000065a'
const SPACE_B = '01990000-0000-7000-8000-00000000065b'
const SPACE_C = '01990000-0000-7000-8000-00000000066b'
const PROJECT_A = '01990000-0000-7000-8000-00000000065c'
const PROJECT_A_OTHER = '01990000-0000-7000-8000-00000000068c'
const PROJECT_B = '01990000-0000-7000-8000-00000000066c'
const PROJECT_MOVE = '01990000-0000-7000-8000-00000000067c'
const MACHINE = '01990000-0000-7000-8000-00000000067d'
const interval: IntervalEvidence = {
  id: '01990000-0000-7000-8000-000000000690',
  task_key: 'DEV-655',
  project_name: PLATFORM_SLUG,
  projectId: PROJECT_A,
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
const day = {
  id: '01990000-0000-7000-8000-000000000691',
  machine_id: MACHINE,
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
}
// The proof seeds a second day on September 18; keep both days behind the reporting clock.
const FIXED_CLOCK = Date.parse('2026-09-19T20:00:00.000Z')

async function pushEvidence(
  url: SQL,
  identity: { userId: string; spaceId: string },
  changes: HostedPushChange[],
) {
  const outcomes = await applyHostedPushChanges(url, identity, changes)
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
  if (rejected?.status === 'rejected') throw new Error(rejected.reason)
  return outcomes
}

async function listAllHostedTasks(url: SQL, identity: Parameters<typeof listHostedTasks>[1]) {
  type Page = Awaited<ReturnType<typeof listHostedTasks>>
  const rows = {
    tasks: [] as Page['tasks'],
    comments: [] as Page['comments'],
    documents: [] as Page['documents'],
    statusEvents: [] as Page['statusEvents'],
  }
  let cursor: string | undefined
  for (;;) {
    const page = await listHostedTasks(url, identity, cursor ? { cursor } : {})
    rows.tasks.push(...page.tasks)
    rows.comments.push(...page.comments)
    rows.documents.push(...page.documents)
    rows.statusEvents.push(...page.statusEvents)
    if (!page.more) return rows
    if (page.cursor === cursor) throw new Error('hosted task list cursor did not advance')
    cursor = page.cursor
  }
}

const pushIntervals = (
  url: SQL,
  identity: { userId: string; spaceId: string },
  rows: IntervalEvidence[],
) =>
  pushEvidence(
    url,
    identity,
    rows.map((row) => ({ table: 'hub_interval', id: row.id, op: 'upsert', row })),
  )

const pushDays = (url: SQL, identity: { userId: string; spaceId: string }, rows: PushedDay[]) =>
  pushEvidence(
    url,
    identity,
    rows.map((row) => ({ table: 'hub_day', id: row.id, op: 'upsert', row })),
  )

const pushIntervalDeletes = (
  url: SQL,
  identity: { userId: string; spaceId: string },
  ids: string[],
) =>
  pushEvidence(
    url,
    identity,
    ids.map((id) => ({ table: 'hub_interval', id, op: 'delete' })),
  )

async function proveRecordChangeRows(admin: SQL, actor: SQL) {
  const identityA = { userId: USER, spaceId: SPACE_A }
  const identityB = { userId: USER, spaceId: SPACE_B }
  const deleteProject = newRecordId()
  await admin`INSERT INTO project(id,space_id,name,key_prefixes,created_at)
    VALUES (${deleteProject}::uuid,${SPACE_B}::uuid,'record-delete',ARRAY['RCD'],now())`
  const inserted = await admin<{ xid: string; seq: string }[]>`SELECT xid::text, seq::text
    FROM record_change WHERE table_name='project' AND row_id=${deleteProject}::uuid
    ORDER BY record_change.xid DESC, record_change.seq DESC LIMIT 1`
  await actor.begin(async (tx) => {
    await bindTenant(tx, identityB)
    await tx`DELETE FROM project WHERE id=${deleteProject}::uuid`
  })
  const deleted = await readRecordChanges(
    actorUrl,
    identityB,
    { xid: BigInt(inserted[0]!.xid), seq: BigInt(inserted[0]!.seq) },
    10,
    RECORD_CHANGE_LOGGED_TABLES,
  )
  if (deleted.resetRequired || deleted.changes[0]?.op !== 'delete')
    throw new Error('record change reader did not return a delete tombstone')

  const moveProject = newRecordId()
  await admin`INSERT INTO project(id,space_id,name,key_prefixes,created_at)
    VALUES (${moveProject}::uuid,${SPACE_B}::uuid,'record-move',ARRAY['RCM'],now())`
  const beforeMove = await admin<{ xid: string; seq: string }[]>`SELECT xid::text, seq::text
    FROM record_change WHERE table_name='project' AND row_id=${moveProject}::uuid
    ORDER BY record_change.xid DESC, record_change.seq DESC LIMIT 1`
  const beforeMoveCursor = {
    xid: BigInt(beforeMove[0]!.xid),
    seq: BigInt(beforeMove[0]!.seq),
  }
  await admin`UPDATE project SET space_id=${SPACE_A}::uuid WHERE id=${moveProject}::uuid`
  const oldSpace = await readRecordChanges(
    actorUrl,
    identityB,
    beforeMoveCursor,
    10,
    RECORD_CHANGE_LOGGED_TABLES,
  )
  const newSpace = await readRecordChanges(
    actorUrl,
    identityA,
    beforeMoveCursor,
    10,
    RECORD_CHANGE_LOGGED_TABLES,
  )
  if (oldSpace.resetRequired || oldSpace.changes[0]?.op !== 'delete')
    throw new Error('space move did not write a tombstone for the old space')
  if (newSpace.resetRequired || newSpace.changes[0]?.op !== 'upsert')
    throw new Error('space move did not write an upsert for the new space')

  await admin`UPDATE record_change SET at=now()-interval '31 days'
    WHERE row_id=${moveProject}::uuid`
  await admin`SELECT record_change_prune()`
  const horizonRows = await admin<{ xid: string; seq: string }[]>`SELECT xid::text, seq::text
    FROM record_change_horizon`
  const horizon = {
    xid: BigInt(horizonRows[0]!.xid),
    seq: BigInt(horizonRows[0]!.seq),
  }
  const reset = await readRecordChanges(
    actorUrl,
    identityA,
    { xid: horizon.xid, seq: horizon.seq - 1n },
    10,
    RECORD_CHANGE_LOGGED_TABLES,
  )
  if (
    !reset.resetRequired ||
    reset.horizon.xid !== horizon.xid ||
    reset.horizon.seq !== horizon.seq ||
    reset.cursor.xid !== horizon.xid ||
    reset.cursor.seq !== horizon.seq
  )
    throw new Error('record change pruning did not return the reset horizon')
}

async function proveHostedRecordChangeFeed(admin: SQL) {
  const identity = { userId: USER, spaceId: SPACE_A, spaceIds: [SPACE_A, SPACE_B] }
  const first = await readHostedRecordChanges(actorUrl, identity, { after: null, limit: 500 })
  if (!first.resetRequired) throw new Error('hosted change feed did not reset without a cursor')
  const task = newRecordId()
  const note = newRecordId()
  const hidden = newRecordId()
  await admin`INSERT INTO hub_task
    (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES (${task}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},'DEV-699',${PLATFORM_SLUG},'feed task','local',now(),now(),now(),now())`
  await admin`INSERT INTO hub_note
    (id,space_id,project_name,number,project,text,anchors,sightings,created_at,last_seen_at,updated_at)
    VALUES (${note}::uuid,${SPACE_B}::uuid,${PLATFORM_SLUG},698,${PLATFORM_SLUG},'feed note','[]',1,now(),now(),now())`
  await admin`INSERT INTO hub_note
    (id,space_id,project_name,number,project,text,anchors,sightings,created_at,last_seen_at,updated_at,
      author_user_id)
    VALUES (${hidden}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},699,${PLATFORM_SLUG},'hidden feed note','[]',1,now(),now(),now(),
      ${SECOND_USER}::uuid)`
  await actorUrl.begin(async (tx) => {
    await bindTenant(tx, { userId: OWNER_USER, spaceId: SPACE_A, spaceIds: [SPACE_A] })
    await tx`SELECT public.hub_note_set_hidden(${hidden}::uuid,'spam',${OWNER_USER}::uuid)`
  })
  const page = await readHostedRecordChanges(actorUrl, identity, {
    after: first.cursor,
    limit: 500,
  })
  if (page.resetRequired) throw new Error('hosted change feed reset after its horizon')
  const byId = new Map(page.changes.map((change) => [change.id, change]))
  if (byId.get(task)?.space !== SPACE_A || byId.get(task)?.op !== 'upsert')
    throw new Error('hosted change feed did not return the task from the first space')
  if (byId.get(note)?.space !== SPACE_B || byId.get(note)?.op !== 'upsert')
    throw new Error('hosted change feed did not return the note from the second space')
  if (byId.get(hidden)?.op !== 'delete')
    throw new Error('hosted change feed did not hide a non-author note as a delete')
  await admin`DELETE FROM hub_note WHERE id=ANY(${admin.array([note, hidden], 'uuid')})`
  await admin`DELETE FROM hub_task WHERE id=${task}::uuid`
}

type EvidenceChangeCursor = { xid: bigint; seq: bigint }

async function latestRecordChange(admin: SQL, rowId?: string): Promise<EvidenceChangeCursor> {
  const found = rowId
    ? await admin<{ xid: string; seq: string }[]>`SELECT xid::text, seq::text
        FROM record_change WHERE table_name='project' AND row_id=${rowId}::uuid
        ORDER BY record_change.xid DESC, record_change.seq DESC LIMIT 1`
    : await admin<{ xid: string; seq: string }[]>`SELECT xid::text, seq::text
        FROM record_change WHERE space_id=${SPACE_A}::uuid ORDER BY record_change.xid DESC, record_change.seq DESC LIMIT 1`
  return { xid: BigInt(found[0]!.xid), seq: BigInt(found[0]!.seq) }
}

async function proveRecordChangeCutoff(admin: SQL, connectionA: SQL, connectionB: SQL) {
  const identityA = { userId: USER, spaceId: SPACE_A }
  let releaseA: () => void = () => undefined
  let transactionA: Promise<unknown> | undefined
  try {
    const baseline = await latestRecordChange(admin)
    const heldA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    let publishA!: (cursor: { xid: bigint; seq: bigint }) => void
    const cursorA = new Promise<{ xid: bigint; seq: bigint }>((resolve) => {
      publishA = resolve
    })
    transactionA = connectionA.begin(async (tx) => {
      await bindTenant(tx, identityA)
      await tx`UPDATE project SET color='#111111' WHERE id=${PROJECT_A}::uuid`
      publishA(await latestRecordChange(tx, PROJECT_A))
      await heldA
    })
    const changeA = await cursorA
    await connectionB.begin(async (tx) => {
      await bindTenant(tx, identityA)
      await tx`UPDATE project SET color='#222222' WHERE id=${PROJECT_A_OTHER}::uuid`
    })
    const changeB = await latestRecordChange(admin, PROJECT_A_OTHER)
    if (changeB.seq <= changeA.seq)
      throw new Error('later record change did not receive a later sequence')

    const heldRead = await readRecordChanges(
      actorUrl,
      identityA,
      baseline,
      10,
      RECORD_CHANGE_LOGGED_TABLES,
    )
    if (
      heldRead.resetRequired ||
      heldRead.changes.length !== 0 ||
      heldRead.cursor.xid !== baseline.xid ||
      heldRead.cursor.seq !== baseline.seq ||
      heldRead.lag !== 1
    )
      throw new Error('open transaction did not hold back later xids and grow count lag')

    releaseA()
    await transactionA
    const released = await readRecordChanges(
      actorUrl,
      identityA,
      baseline,
      10,
      RECORD_CHANGE_LOGGED_TABLES,
    )
    if (
      released.resetRequired ||
      released.changes.length < 2 ||
      released.changes[0]?.xid !== changeA.xid ||
      released.changes[0]?.seq !== changeA.seq ||
      released.changes[1]?.xid !== changeB.xid ||
      released.changes[1]?.seq !== changeB.seq
    )
      throw new Error('record change reader did not return released transactions in xid order')
    return released.cursor
  } finally {
    releaseA()
    await transactionA?.catch(() => undefined)
  }
}

async function proveRecordChangePairCursor(
  connectionA: SQL,
  connectionB: SQL,
  baseline: EvidenceChangeCursor,
) {
  const identityA = { userId: USER, spaceId: SPACE_A }
  let continueX: () => void = () => undefined
  let releaseY: () => void = () => undefined
  let transactionX: Promise<unknown> | undefined
  let transactionY: Promise<unknown> | undefined
  try {
    const yMayStart = new Promise<void>((resolve) => {
      continueX = resolve
    })
    let publishXFirst!: (cursor: { xid: bigint; seq: bigint }) => void
    const xFirst = new Promise<{ xid: bigint; seq: bigint }>((resolve) => {
      publishXFirst = resolve
    })
    transactionX = connectionA.begin(async (tx) => {
      await bindTenant(tx, identityA)
      await tx`UPDATE project SET color='#333333' WHERE id=${PROJECT_A}::uuid`
      publishXFirst(await latestRecordChange(tx, PROJECT_A))
      await yMayStart
      await tx`UPDATE project SET color='#444444' WHERE id=${PROJECT_A}::uuid`
    })
    const firstX = await xFirst

    const heldY = new Promise<void>((resolve) => {
      releaseY = resolve
    })
    let publishY!: (cursor: { xid: bigint; seq: bigint }) => void
    const cursorY = new Promise<{ xid: bigint; seq: bigint }>((resolve) => {
      publishY = resolve
    })
    transactionY = connectionB.begin(async (tx) => {
      await bindTenant(tx, identityA)
      await tx`UPDATE project SET color='#555555' WHERE id=${PROJECT_A_OTHER}::uuid`
      publishY(await latestRecordChange(tx, PROJECT_A_OTHER))
      await heldY
    })
    const changeY = await cursorY
    continueX()
    await transactionX

    const whileYOpen = await readRecordChanges(
      actorUrl,
      identityA,
      baseline,
      10,
      RECORD_CHANGE_LOGGED_TABLES,
    )
    if (
      whileYOpen.resetRequired ||
      whileYOpen.changes.length !== 2 ||
      whileYOpen.changes.some((change) => change.xid !== firstX.xid) ||
      whileYOpen.cursor.xid !== firstX.xid ||
      whileYOpen.cursor.seq <= changeY.seq ||
      whileYOpen.lag !== 0
    )
      throw new Error(
        `older transaction changes were not readable while the younger xid stayed open: ${
          whileYOpen.resetRequired
            ? 'reset'
            : `${whileYOpen.changes.length} changes, cursor ${whileYOpen.cursor.xid}:${whileYOpen.cursor.seq}, lag ${whileYOpen.lag}, younger ${changeY.xid}:${changeY.seq}`
        }`,
      )

    releaseY()
    await transactionY
    const afterYCommit = await readRecordChanges(
      actorUrl,
      identityA,
      whileYOpen.cursor,
      10,
      RECORD_CHANGE_LOGGED_TABLES,
    )
    if (
      afterYCommit.resetRequired ||
      afterYCommit.changes.length !== 1 ||
      afterYCommit.changes[0]?.xid !== changeY.xid ||
      afterYCommit.changes[0]?.seq !== changeY.seq
    )
      throw new Error('pair cursor skipped the younger xid with an earlier sequence')
  } finally {
    continueX()
    releaseY()
    await Promise.allSettled([transactionX, transactionY].filter(Boolean) as Promise<unknown>[])
  }
}

async function proveRecordChangeOrdering(admin: SQL) {
  const connectionA = new SQL(actorDatabaseUrl!, { max: 1 })
  const connectionB = new SQL(actorDatabaseUrl!, { max: 1 })
  try {
    const baseline = await proveRecordChangeCutoff(admin, connectionA, connectionB)
    await proveRecordChangePairCursor(connectionA, connectionB, baseline)
    await proveRecordChangeRows(admin, connectionB)
    await proveHostedRecordChangeFeed(admin)
  } finally {
    await connectionA.close()
    await connectionB.close()
  }
}

async function proveRecordChangeMultiSpacePolicyAndNotify(admin: SQL) {
  const actor = new SQL(actorDatabaseUrl!, { max: 1 })
  try {
    const visible = await actor.begin(async (tx) => {
      await bindTenant(tx, { userId: USER, spaceId: SPACE_A, spaceIds: [SPACE_A, SPACE_B] })
      return tx<{ space_id: string }[]>`SELECT DISTINCT space_id::text FROM record_change
        WHERE space_id=ANY(string_to_array(${`${SPACE_A},${SPACE_B}`},',')::uuid[])`
    })
    if (
      !visible.some((row) => row.space_id === SPACE_A) ||
      !visible.some((row) => row.space_id === SPACE_B)
    )
      throw new Error('record change multi-space policy did not expose both member spaces')
    const hidden = await actor.begin(async (tx) => {
      await bindTenant(tx, { userId: SECOND_USER, spaceId: SPACE_A, spaceIds: [SPACE_A] })
      return tx`SELECT 1 FROM record_change WHERE space_id=ANY(string_to_array(${`${SPACE_B},${SPACE_C}`},',')::uuid[]) LIMIT 1`
    })
    if (hidden.length)
      throw new Error('record change multi-space policy exposed a non-member space')

    const listener = new SQL(actorDatabaseUrl!, { max: 1 })
    let notifications = 0
    const notified = new Promise<void>((resolve) => {
      void listener.listen('record_change_advanced', () => {
        notifications++
        resolve()
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await admin.begin(async (tx) => {
      await tx`UPDATE project SET color='#121212' WHERE id=${PROJECT_A}::uuid`
      await tx`UPDATE project SET color='#131313' WHERE id=${PROJECT_A_OTHER}::uuid`
    })
    await Promise.race([
      notified,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('record change notification did not fire')), 2_000),
      ),
    ])
    await new Promise((resolve) => setTimeout(resolve, 20))
    await listener.close()
    if (notifications !== 1)
      throw new Error(
        `record change transaction sent ${notifications} notifications instead of one`,
      )
  } finally {
    await actor.close()
  }
}

const admin = new SQL(adminUrl)
try {
  await admin`INSERT INTO "user" (id,email,name,email_verified,created_at,updated_at)
    VALUES (${USER}::uuid,'hub-evidence@example.test','Hub Evidence',true,now(),now()),
      (${SECOND_USER}::uuid,'hub-second@example.test','Hub Second',true,now(),now()),
      (${READ_USER}::uuid,'hub-read@example.test','Hub Read',true,now(),now()),
      (${OUTSIDE_USER}::uuid,'hub-outside@example.test','Hub Outside',true,now()-interval '2 days',now()),
      (${OTHER_OUTSIDE_USER}::uuid,'hub-other-outside@example.test','Hub Other Outside',true,now()-interval '2 days',now()),
      (${OWNER_USER}::uuid,'hub-owner@example.test','Hub Owner',true,now(),now())`
  await admin`INSERT INTO space (id,name,slug,created_at) VALUES
    (${SPACE_A}::uuid,'Evidence A','evidence-a',now()),
    (${SPACE_B}::uuid,'Evidence B','evidence-b',now()),
    (${SPACE_C}::uuid,'Evidence C','evidence-c',now())`
  await admin`INSERT INTO project(id,space_id,name,key_prefixes,created_at)
    VALUES (${PROJECT_A}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},ARRAY['DEV'],now()),
      (${PROJECT_A_OTHER}::uuid,${SPACE_A}::uuid,'other-project',ARRAY['OTHER'],now()),
      (${PROJECT_B}::uuid,${SPACE_B}::uuid,${PLATFORM_SLUG},ARRAY['DEV'],now()),
      (${PROJECT_MOVE}::uuid,${SPACE_B}::uuid,'move-proof',ARRAY['MOVE'],now())`
  await admin`INSERT INTO membership(id,space_id,user_id,role,permission,created_at)
    VALUES (${newRecordId()}::uuid,${SPACE_A}::uuid,${USER}::uuid,'member','write',now()),
      (${newRecordId()}::uuid,${SPACE_B}::uuid,${USER}::uuid,'member','write',now()),
      (${newRecordId()}::uuid,${SPACE_C}::uuid,${USER}::uuid,'owner','write',now()),
      (${newRecordId()}::uuid,${SPACE_A}::uuid,${SECOND_USER}::uuid,'member','write',now()),
      (${newRecordId()}::uuid,${SPACE_A}::uuid,${READ_USER}::uuid,'member','read',now()),
      (${newRecordId()}::uuid,${SPACE_A}::uuid,${OWNER_USER}::uuid,'owner','write',now())`
  await admin`INSERT INTO machine(id,user_id,name,registered_at,last_seen)
    VALUES (${MACHINE}::uuid,${USER}::uuid,'evidence-machine',now(),now())`

  const statementTimeout = await boundedActorUrl<{ statement_timeout: string }[]>`
    SHOW statement_timeout`
  const idleTimeout = await boundedActorUrl<{ idle_in_transaction_session_timeout: string }[]>`
    SHOW idle_in_transaction_session_timeout`
  if (
    statementTimeout[0]?.statement_timeout !== RECORD_SERVICE_STATEMENT_TIMEOUT ||
    idleTimeout[0]?.idle_in_transaction_session_timeout !==
      RECORD_SERVICE_IDLE_IN_TRANSACTION_TIMEOUT
  )
    throw new Error('hosted service pool did not apply both record transaction bounds')

  await proveRecordChangeOrdering(admin)
  await proveRecordChangeMultiSpacePolicyAndNotify(admin)

  const intakeId = newRecordId()
  const outsideTokens = new Map([
    ['outside-token', OUTSIDE_USER],
    ['other-outside-token', OTHER_OUTSIDE_USER],
    ['member-token', USER],
    ['read-member-token', READ_USER],
  ])
  const outsideFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
    const userId = outsideTokens.get(token)
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const membershipRows = await admin<
      { space_id: string; slug: string; permission: 'read' | 'write' }[]
    >`SELECT m.space_id::text,s.slug,m.permission FROM membership m JOIN space s ON s.id=m.space_id
      WHERE m.user_id=${userId}::uuid`
    return Response.json({
      user: { id: userId },
      activeSpaceId: SPACE_C,
      memberships: [...membershipRows],
    })
  }) as typeof fetch
  const outsideRequest = (token: string, method: 'GET' | 'POST', path: string, body?: unknown) =>
    noteApi(
      new Request(`https://hub.example.test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: actorUrl },
      { fetch: outsideFetch },
    )
  const d2NoteIds: string[] = []
  try {
    await admin`INSERT INTO space_outside_intake(id,space_id,project_id,updated_at)
      VALUES (${intakeId}::uuid,${SPACE_A}::uuid,${PROJECT_A}::uuid,now())`
    const anchor = JSON.stringify({
      cwd: '/tmp',
      project: PLATFORM_SLUG,
      files: [],
      run_record_id: null,
      branch: null,
      commit: null,
      session_id: null,
    })
    const malformed = await outsideRequest('outside-token', 'POST', '/v1/notes/outside', {
      project: PLATFORM_SLUG,
      text: 'malformed anchor outside note',
      anchor: 'not json',
    })
    const malformedCounts = await admin<{ notes: string; writes: string }[]>`
      SELECT
        (SELECT count(*) FROM hub_note WHERE author_user_id=${OUTSIDE_USER}::uuid
          AND text='malformed anchor outside note')::text AS notes,
        (SELECT count(*) FROM space_outside_write WHERE user_id=${OUTSIDE_USER}::uuid)::text AS writes`
    if (
      malformed?.status !== 400 ||
      malformedCounts[0]?.notes !== '0' ||
      malformedCounts[0]?.writes !== '0'
    )
      throw new Error('malformed outside note anchor wrote a note or outside-write ledger row')

    const first = await outsideRequest('outside-token', 'POST', '/v1/notes/outside', {
      project: PLATFORM_SLUG,
      text: 'first outside note',
      area: 'hub',
      anchor,
    })
    const second = await outsideRequest('outside-token', 'POST', '/v1/notes/outside', {
      project: PLATFORM_SLUG,
      text: 'second outside note',
      anchor,
    })
    const other = await outsideRequest('other-outside-token', 'POST', '/v1/notes/outside', {
      project: PLATFORM_SLUG,
      text: 'another author note',
      anchor,
    })
    const firstBody = (await first?.json()) as { number?: number }
    const secondBody = (await second?.json()) as { number?: number }
    if (
      first?.status !== 201 ||
      second?.status !== 201 ||
      other?.status !== 201 ||
      secondBody.number !== Number(firstBody.number) + 1
    )
      throw new Error('outside note route did not allocate consecutive project note numbers')

    await actorUrl.begin(async (tx) => {
      await bindTenant(tx, { userId: OWNER_USER, spaceId: SPACE_A, spaceIds: [SPACE_A] })
      const note = await tx<{ id: string }[]>`SELECT id::text FROM hub_note
        WHERE space_id=${SPACE_A}::uuid AND project_name=${PLATFORM_SLUG}
          AND number=${firstBody.number!}`
      await tx`SELECT public.hub_note_set_hidden(${note[0]!.id}::uuid,'spam',${OWNER_USER}::uuid)`
    })
    const memberAfterHide = await listHostedNotes(actorUrl, { userId: USER, spaceId: SPACE_A }, {})
    const authorAfterHide = await listHostedNotes(
      actorUrl,
      { userId: OUTSIDE_USER, spaceId: SPACE_A },
      {},
    )
    const ownerAfterHide = await listHostedNotes(
      actorUrl,
      { userId: OWNER_USER, spaceId: SPACE_A },
      {},
    )
    if (memberAfterHide.notes.some((row) => row.text === 'first outside note'))
      throw new Error('a member observed an owner-hidden outside note')
    if (!authorAfterHide.notes.some((row) => row.text === 'first outside note'))
      throw new Error('an outside author could not observe their owner-hidden note')
    if (!ownerAfterHide.notes.some((row) => row.text === 'first outside note'))
      throw new Error('the space owner could not observe an owner-hidden note')

    const memberNote = await createHostedNote(
      actorUrl,
      { userId: USER, spaceId: SPACE_A },
      {
        project: PLATFORM_SLUG,
        projectId: PROJECT_A,
        text: 'D2 evidence member-authored note',
        anchor,
      },
    )
    if (!memberNote) throw new Error('member-authored moderation evidence note was not created')
    d2NoteIds.push(memberNote.id)
    const crossSpaceAuthorRead = await listHostedNotes(
      actorUrl,
      { userId: USER, spaceId: SPACE_B },
      {},
    )
    if (crossSpaceAuthorRead.notes.some((row) => row.id === memberNote.id))
      throw new Error('a member read their SPACE_A note through cross-space author access')
    let directNoteUpdateRefused = false
    try {
      await actorUrl.begin(async (tx) => {
        await bindTenant(tx, { userId: USER, spaceId: SPACE_A, spaceIds: [SPACE_A] })
        await tx`UPDATE hub_note SET hidden_at=now(),hidden_by_user_id=${USER}::uuid,
          hidden_reason='spam' WHERE id=${memberNote.id}::uuid`
      })
    } catch (error) {
      directNoteUpdateRefused = String(error).includes(
        'hidden fields may only be changed through owner moderation',
      )
    }
    if (!directNoteUpdateRefused)
      throw new Error('a write member changed note hidden fields without owner moderation')
    const directInsertId = newRecordId()
    let directHiddenInsertRefused = false
    try {
      await actorUrl.begin(async (tx) => {
        await bindTenant(tx, { userId: USER, spaceId: SPACE_A, spaceIds: [SPACE_A] })
        await tx`INSERT INTO hub_note
          (id,space_id,project_name,project_id,author_user_id,number,project,text,anchors,
           sightings,created_at,last_seen_at,updated_at,hidden_at,hidden_by_user_id,hidden_reason)
          VALUES (${directInsertId}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${PROJECT_A}::uuid,
          ${USER}::uuid,900001,${PLATFORM_SLUG},'direct hidden insert','[]',1,now(),now(),now(),
          now(),${OWNER_USER}::uuid,'spam')`
      })
    } catch (error) {
      directHiddenInsertRefused = String(error).includes(
        'hidden fields may only be changed through owner moderation',
      )
    }
    if (!directHiddenInsertRefused)
      throw new Error('a write member inserted a note with hidden fields')
    await actorUrl.begin(async (tx) => {
      await bindTenant(tx, { userId: USER, spaceId: SPACE_A, spaceIds: [SPACE_A] })
      await tx`INSERT INTO hub_note
        (id,space_id,project_name,project_id,author_user_id,number,project,text,anchors,
         sightings,created_at,last_seen_at,updated_at)
        VALUES (${directInsertId}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${PROJECT_A}::uuid,
        ${USER}::uuid,900001,${PLATFORM_SLUG},'ordinary direct insert','[]',1,now(),now(),now())`
    })
    d2NoteIds.push(directInsertId)
    let naturalKeyConflictRefused = false
    try {
      await mirrorHostedNotes(
        actorUrl,
        { userId: USER, spaceId: SPACE_A },
        {
          notes: [
            {
              ...memberNote,
              id: newRecordId(),
              number: 900001,
              projectId: PROJECT_A_OTHER,
              text: 'must not report a natural-key conflict as hidden',
            },
          ],
          acknowledgements: [],
        },
      )
    } catch (error) {
      naturalKeyConflictRefused = String(error).includes('hub_note_space_project_number_unique')
    }
    if (!naturalKeyConflictRefused)
      throw new Error('a note natural-key conflict was reported as a hidden-row skip')
    await actorUrl.begin(async (tx) => {
      await bindTenant(tx, { userId: OWNER_USER, spaceId: SPACE_A, spaceIds: [SPACE_A] })
      await tx`SELECT public.hub_note_set_hidden(${memberNote.id}::uuid,'abuse',${OWNER_USER}::uuid)`
    })
    if (!(await getHostedNote(actorUrl, { userId: USER, spaceId: SPACE_A }, memberNote.id)))
      throw new Error('a hub-collected note author lost sight of their hidden note')
    if (await getHostedNote(actorUrl, { userId: SECOND_USER, spaceId: SPACE_A }, memberNote.id))
      throw new Error('a non-author member observed a hidden hub-collected note')
    await actorUrl.begin(async (tx) => {
      await bindTenant(tx, { userId: OWNER_USER, spaceId: SPACE_A, spaceIds: [SPACE_A] })
      await tx`SELECT public.hub_note_set_hidden(${memberNote.id}::uuid,NULL,${OWNER_USER}::uuid)`
    })

    const mirroredNote = await createHostedNote(
      actorUrl,
      { userId: SECOND_USER, spaceId: SPACE_A },
      {
        project: PLATFORM_SLUG,
        projectId: PROJECT_A,
        text: 'D2 evidence mirror source',
        anchor,
      },
    )
    if (!mirroredNote) throw new Error('hidden mirror evidence note was not created')
    d2NoteIds.push(mirroredNote.id)
    await actorUrl.begin(async (tx) => {
      await bindTenant(tx, { userId: OWNER_USER, spaceId: SPACE_A, spaceIds: [SPACE_A] })
      await tx`SELECT public.hub_note_set_hidden(${mirroredNote.id}::uuid,'duplicate',${OWNER_USER}::uuid)`
    })
    const acknowledgementId = newRecordId()
    const mirror = await mirrorHostedNotes(
      actorUrl,
      { userId: USER, spaceId: SPACE_A },
      {
        notes: [{ ...mirroredNote, projectId: PROJECT_A, text: 'must not overwrite hidden text' }],
        acknowledgements: [
          {
            id: acknowledgementId,
            note_id: mirroredNote.id,
            project_name: PLATFORM_SLUG,
            projectId: PROJECT_A,
            session_id: 'hidden-note-acknowledgement',
            acknowledged_at: new Date().toISOString(),
            sightings: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: null,
          },
        ],
      },
    )
    if (
      mirror.upserted !== 0 ||
      !mirror.skippedHidden.includes(mirroredNote.id) ||
      !mirror.skippedHidden.includes(acknowledgementId)
    )
      throw new Error('a hidden note mirror did not report its note and acknowledgement skipped')
    const unchanged = await admin<
      { text: string; hidden_reason: string; hidden_by_user_id: string }[]
    >`SELECT text,hidden_reason,hidden_by_user_id::text FROM hub_note WHERE id=${mirroredNote.id}::uuid`
    if (
      unchanged[0]?.text !== 'D2 evidence mirror source' ||
      unchanged[0]?.hidden_reason !== 'duplicate' ||
      unchanged[0]?.hidden_by_user_id !== OWNER_USER
    )
      throw new Error('a skipped hidden note mirror changed the hosted row')
    await actorUrl.begin(async (tx) => {
      await bindTenant(tx, { userId: OWNER_USER, spaceId: SPACE_A, spaceIds: [SPACE_A] })
      await tx`SELECT public.hub_note_set_hidden(${mirroredNote.id}::uuid,NULL,${OWNER_USER}::uuid)`
    })
    const successfulOutsideWrites = await admin<{ writes: string }[]>`
      SELECT count(*)::text AS writes FROM space_outside_write
      WHERE user_id=${OUTSIDE_USER}::uuid AND kind='note'`
    if (successfulOutsideWrites[0]?.writes !== '2')
      throw new Error('outside note route did not record one ledger row per successful note')

    const member = await outsideRequest('member-token', 'POST', '/v1/notes/outside', {
      project: PLATFORM_SLUG,
      text: 'member outside note',
      anchor,
    })
    if (
      member?.status !== 409 ||
      !String(((await member.json()) as { error?: string }).error).includes('register the project')
    )
      throw new Error('outside note route admitted a write member of the intake space')

    const readMember = await outsideRequest('read-member-token', 'POST', '/v1/notes/outside', {
      project: PLATFORM_SLUG,
      text: 'read member outside note',
      anchor,
    })
    const readMemberBody = (await readMember?.json()) as { error?: string; remedy?: string }
    if (
      readMember?.status !== 403 ||
      !readMemberBody.error?.includes('membership is read-only') ||
      !readMemberBody.remedy?.includes('space owner or admin')
    )
      throw new Error('outside note route admitted a read member of the intake space')

    const listed = await outsideRequest(
      'outside-token',
      'GET',
      `/v1/notes/outside?project=${encodeURIComponent(PLATFORM_SLUG)}`,
    )
    const listedBody = (await listed?.json()) as Array<{
      text: string
      area: string | null
      anchors: unknown[]
    }>
    const listedFirst = listedBody.find((row) => row.text === 'first outside note')
    if (
      listed?.status !== 200 ||
      listedFirst?.area !== 'hub' ||
      listedFirst.anchors.length !== 1 ||
      listedBody.some((row) => row.text === 'another author note')
    )
      throw new Error('outside note read-back did not isolate the caller author')

    const seededSubjects = Array.from({ length: OUTSIDE_WRITES_PER_HOUR - 2 }, () => newRecordId())
    for (const subjectId of seededSubjects)
      await admin`INSERT INTO space_outside_write
        (id,space_id,user_id,kind,subject_id,created_at)
        VALUES (${newRecordId()}::uuid,${SPACE_A}::uuid,${OUTSIDE_USER}::uuid,'note',${subjectId}::uuid,now())`
    const limited = await outsideRequest('outside-token', 'POST', '/v1/notes/outside', {
      project: PLATFORM_SLUG,
      text: 'rate-limited outside note',
      anchor,
    })
    const limitedNotes = await admin<{ notes: string }[]>`
      SELECT count(*)::text AS notes FROM hub_note
      WHERE author_user_id=${OUTSIDE_USER}::uuid AND text='rate-limited outside note'`
    if (limited?.status !== 429 || limitedNotes[0]?.notes !== '0')
      throw new Error('outside note route did not enforce the hourly write limit before insert')
    for (const subjectId of seededSubjects)
      await admin`DELETE FROM space_outside_write WHERE subject_id=${subjectId}::uuid`

    await admin`INSERT INTO space_posting_block
      (id,space_id,user_id,blocked_by_user_id,created_at)
      VALUES (${newRecordId()}::uuid,${SPACE_A}::uuid,${OUTSIDE_USER}::uuid,${USER}::uuid,now())`
    const blocked = await outsideRequest('outside-token', 'POST', '/v1/notes/outside', {
      project: PLATFORM_SLUG,
      text: 'blocked outside note',
      anchor,
    })
    if (
      blocked?.status !== 400 ||
      ((await blocked.json()) as { error?: string }).error !==
        'this space is not accepting outside posts right now'
    )
      throw new Error('outside note route did not preserve the blocked-caller refusal')
  } finally {
    await admin`DELETE FROM space_posting_block WHERE space_id=${SPACE_A}::uuid
      AND user_id IN (${OUTSIDE_USER}::uuid,${OTHER_OUTSIDE_USER}::uuid)`
    await admin`DELETE FROM space_outside_write WHERE space_id=${SPACE_A}::uuid
      AND user_id IN (${OUTSIDE_USER}::uuid,${OTHER_OUTSIDE_USER}::uuid)`
    await admin`DELETE FROM hub_note WHERE space_id=${SPACE_A}::uuid
      AND author_user_id IN (${OUTSIDE_USER}::uuid,${OTHER_OUTSIDE_USER}::uuid)`
    for (const id of d2NoteIds)
      await admin`DELETE FROM hub_note WHERE space_id=${SPACE_A}::uuid AND id=${id}::uuid`
    await admin`DELETE FROM seq WHERE space_id=${SPACE_A}::uuid AND project_id=${PROJECT_A}::uuid
      AND name='note'`
    await admin`DELETE FROM space_outside_intake WHERE id=${intakeId}::uuid`
  }

  const insertedInterval = await pushIntervals(actorUrl, { userId: USER, spaceId: SPACE_A }, [
    interval,
  ])
  if (insertedInterval[0]?.status !== 'applied')
    throw new Error(`interval applied outcome was ${JSON.stringify(insertedInterval[0] ?? null)}`)
  const duplicateInterval = await pushIntervals(actorUrl, { userId: USER, spaceId: SPACE_A }, [
    interval,
  ])
  if (duplicateInterval[0]?.status !== 'duplicate')
    throw new Error(
      `interval duplicate outcome was ${JSON.stringify(duplicateInterval[0] ?? null)}`,
    )

  const insertedDay = await pushDays(actorUrl, { userId: USER, spaceId: SPACE_A }, [day])
  if (insertedDay[0]?.status !== 'applied')
    throw new Error(`day applied outcome was ${JSON.stringify(insertedDay[0] ?? null)}`)
  const duplicateDay = await pushDays(actorUrl, { userId: USER, spaceId: SPACE_A }, [day])
  if (duplicateDay[0]?.status !== 'duplicate')
    throw new Error(`day duplicate outcome was ${JSON.stringify(duplicateDay[0] ?? null)}`)

  const client = actorUrl
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
    await pushDays(actorUrl, { userId: USER, spaceId: SPACE_A }, [{ ...day, messages: 3 }])
    const otherDayId = newRecordId()
    await pushDays(actorUrl, { userId: USER, spaceId: SPACE_A }, [{ ...day, id: otherDayId }]).then(
      () => {
        throw new Error('unknown id replaced the UUID already owning its day')
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes(day.id) || !message.includes(otherDayId)) throw error
      },
    )
    await pushDays(actorUrl, { userId: USER, spaceId: SPACE_A }, [
      { ...day, id: newRecordId(), day: '2026-09-18' },
    ])
    const crossSpaceProjects = await client.begin(async (tx) => {
      await bindTenant(tx, { userId: USER, spaceId: SPACE_A, spaceIds: [SPACE_A, SPACE_B] })
      return tx`SELECT id FROM project WHERE id IN (${PROJECT_A}::uuid,${PROJECT_B}::uuid)`
    })
    if (crossSpaceProjects.length !== 2)
      throw new Error('app.space_ids did not admit a two-space project read')
    const hostedId = await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${USER}, true)`
      await tx`SELECT set_config('app.space_id', ${SPACE_A}, true)`
      const rows = await tx<{ id: string }[]>`SELECT id::text AS id FROM hub_interval`
      return rows[0]!.id
    })
    await pushIntervalDeletes(actorUrl, { userId: USER, spaceId: SPACE_A }, [hostedId])
    if ((await count(SPACE_A, 'hub_interval')) !== 0)
      throw new Error('vanished interval was not deleted')

    const clientIntervalId = interval.id
    const replacementIntervalId = '01990000-0000-7000-8000-000000000696'
    const supersededIntervalId = '01990000-0000-7000-8000-00000000068f'
    await pushIntervals(actorUrl, { userId: USER, spaceId: SPACE_A }, [interval])
    await pushIntervals(actorUrl, { userId: USER, spaceId: SPACE_A }, [
      { ...interval, id: clientIntervalId, vendor_tokens: 250 },
    ])
    const replaced = await pushIntervals(actorUrl, { userId: USER, spaceId: SPACE_A }, [
      { ...interval, id: replacementIntervalId },
    ])
    if (replaced[0]?.status !== 'applied' || replaced[0].replacedId !== clientIntervalId)
      throw new Error('newer interval UUID did not replace the row owning its natural tuple')
    const superseded = await pushIntervals(actorUrl, { userId: USER, spaceId: SPACE_A }, [
      { ...interval, id: supersededIntervalId, vendor_tokens: 500 },
    ])
    if (
      superseded[0]?.status !== 'duplicate' ||
      !superseded[0].reason?.includes(replacementIntervalId)
    )
      throw new Error('older interval UUID was not answered as superseded')
    const tokens = await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${USER}, true)`
      await tx`SELECT set_config('app.space_id', ${SPACE_A}, true)`
      return tx<{ id: string; vendor_tokens: string | number }[]>`
        SELECT id::text AS id, vendor_tokens FROM hub_interval`
    })
    if (
      tokens.length !== 1 ||
      tokens[0]?.id !== replacementIntervalId ||
      Number(tokens[0]?.vendor_tokens) !== interval.vendor_tokens
    )
      throw new Error('interval replacement or superseded push wrote the wrong row')
    await pushIntervals(actorUrl, { userId: USER, spaceId: SPACE_A }, [
      {
        ...interval,
        id: replacementIntervalId,
        ref: 'orch:other',
        start_at: '2026-09-17T13:00:00.000Z',
      },
    ])
    await pushIntervals(actorUrl, { userId: USER, spaceId: SPACE_A }, [interval])
    await pushIntervalDeletes(actorUrl, { userId: USER, spaceId: SPACE_A }, [replacementIntervalId])
    const remaining = await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${USER}, true)`
      await tx`SELECT set_config('app.space_id', ${SPACE_A}, true)`
      return tx<{ id: string }[]>`SELECT id::text AS id FROM hub_interval`
    })
    if (remaining.length !== 1 || remaining[0]!.id !== clientIntervalId)
      throw new Error('delete by id removed a row outside the requested id')
    await pushIntervalDeletes(actorUrl, { userId: USER, spaceId: SPACE_A }, [clientIntervalId])

    const identity = { userId: USER, spaceId: SPACE_A }
    const stamp = '2026-09-17T12:10:00.000Z'
    const waitingTaskA = '01990000-0000-7000-8000-000000000693'
    const waitingTaskB = '01990000-0000-7000-8000-000000000694'
    const unknownWaitingTask = '01990000-0000-7000-8000-000000000695'
    const deletedWaitingTask = '01990000-0000-7000-8000-000000000696'
    await admin`INSERT INTO hub_task
      (id,space_id,project_name,project_id,key,project,title,status,status_category,source,
       first_seen,last_seen,created_at,updated_at) VALUES
      (${waitingTaskA}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${PROJECT_A}::uuid,'DEV-656',${PLATFORM_SLUG},
       'waiting task A','active','active','local',now(),now(),now(),now()),
      (${waitingTaskB}::uuid,${SPACE_B}::uuid,${PLATFORM_SLUG},${PROJECT_B}::uuid,'DEV-656',${PLATFORM_SLUG},
       'waiting task B','active','active','local',now(),now(),now(),now()),
      (${deletedWaitingTask}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${PROJECT_A}::uuid,'DEV-657',${PLATFORM_SLUG},
       'deleted waiting task','active','active','local',now(),now(),now(),now())`
    await admin`UPDATE hub_task SET deleted_at=now() WHERE id=${deletedWaitingTask}::uuid`
    const waitingInput: OperatorWaitingEmailInput = {
      kind: 'question',
      item_id: 943_001,
      item_record_id: null,
      episode: 'fresh-send',
      project: PLATFORM_SLUG,
      task_key: 'DEV-656',
      task_id: null,
      question: 'Should this delivery proceed?',
      options: ['Proceed', 'Stop'],
      recommendation: 'Proceed',
      why: 'This proves the hosted retry ledger.',
      waiting_since: '2026-09-25T08:00:00.000Z',
      link: 'http://127.0.0.1:7778/inbox/question/943001',
      answer_command: `${PLATFORM_SLUG} question answer 943 --q943001 --from-operator "Proceed"`,
    }
    const waitingNow = new Date()
    const linkedInput = {
      ...waitingInput,
      item_id: 943_010,
      episode: 'linked',
      task_id: waitingTaskA,
    }
    const linkedFailure = await sendOperatorWaitingEmail(actorUrl, identity, linkedInput, {
      mail: { send: async () => Promise.reject(new Error('linked retry fixture')) },
      now: waitingNow,
    })
    if (linkedFailure.status !== 'failed') throw new Error('linked waiting email did not fail')
    const foreignInput = {
      ...waitingInput,
      item_id: 943_011,
      episode: 'foreign-task',
      task_key: 'DEV-ABSENT',
      task_id: waitingTaskB,
    }
    await sendOperatorWaitingEmail(actorUrl, identity, foreignInput, {
      mail: { send: async () => undefined },
      now: waitingNow,
    })
    const keyFallbackInput = {
      ...waitingInput,
      item_id: 943_012,
      episode: 'key-fallback',
      task_id: unknownWaitingTask,
    }
    await sendOperatorWaitingEmail(actorUrl, identity, keyFallbackInput, {
      mail: { send: async () => undefined },
      now: waitingNow,
    })
    await sendOperatorWaitingEmail(
      actorUrl,
      identity,
      {
        ...waitingInput,
        item_id: 943_013,
        episode: 'deleted-key',
        task_key: 'DEV-657',
        task_id: null,
      },
      { mail: { send: async () => undefined }, now: waitingNow },
    )
    await sendOperatorWaitingEmail(
      actorUrl,
      identity,
      {
        ...waitingInput,
        item_id: 943_014,
        episode: 'deleted-id',
        task_key: null,
        task_id: deletedWaitingTask,
      },
      { mail: { send: async () => undefined }, now: waitingNow },
    )
    await sendOperatorWaitingEmail(
      actorUrl,
      identity,
      { ...linkedInput, task_id: null, task_key: null },
      { mail: { send: async () => undefined }, now: new Date(waitingNow.getTime() + 1) },
    )
    const waitingTaskLinks = await admin<{ episode: string; task_id: string | null }[]>`
      SELECT episode,task_id::text FROM operator_waiting_email
      WHERE space_id=${SPACE_A}::uuid
        AND episode IN ('linked','foreign-task','key-fallback','deleted-key','deleted-id')
      ORDER BY episode`
    if (
      JSON.stringify([...waitingTaskLinks]) !==
      JSON.stringify([
        { episode: 'deleted-id', task_id: null },
        { episode: 'deleted-key', task_id: null },
        { episode: 'foreign-task', task_id: null },
        { episode: 'key-fallback', task_id: waitingTaskA },
        { episode: 'linked', task_id: waitingTaskA },
      ])
    )
      throw new Error(`operator waiting task links were ${JSON.stringify([...waitingTaskLinks])}`)
    await admin`DELETE FROM hub_task WHERE id IN
      (${waitingTaskA}::uuid,${waitingTaskB}::uuid,${deletedWaitingTask}::uuid)`
    const sent: string[] = []
    const sentCount = () => sent.length
    const mail = { send: async () => void sent.push('sent') }
    const fresh = await sendOperatorWaitingEmail(actorUrl, identity, waitingInput, {
      mail,
      now: waitingNow,
    })
    const duplicate = await sendOperatorWaitingEmail(actorUrl, identity, waitingInput, {
      mail,
      now: waitingNow,
    })
    if (fresh.status !== 'sent' || duplicate.status !== 'sent' || sentCount() !== 1)
      throw new Error('operator waiting fresh send was not idempotent after sent')

    const firstItemRecordId = '01990000-0000-7000-8000-000000000697'
    const secondItemRecordId = '01990000-0000-7000-8000-000000000698'
    const recordIdentityInput = {
      ...waitingInput,
      item_id: 943_020,
      item_record_id: firstItemRecordId,
      episode: 'item-record-identity',
    }
    const identityMail = { send: async () => undefined }
    const firstRecord = await sendOperatorWaitingEmail(actorUrl, identity, recordIdentityInput, {
      mail: identityMail,
      now: waitingNow,
    })
    const repeatedRecord = await sendOperatorWaitingEmail(actorUrl, identity, recordIdentityInput, {
      mail: identityMail,
      now: waitingNow,
    })
    const secondRecord = await sendOperatorWaitingEmail(
      actorUrl,
      identity,
      { ...recordIdentityInput, item_record_id: secondItemRecordId },
      { mail: identityMail, now: waitingNow },
    )
    const olderRecord = await sendOperatorWaitingEmail(
      actorUrl,
      identity,
      { ...recordIdentityInput, item_record_id: null },
      { mail: identityMail, now: waitingNow },
    )
    const repeatedOlderRecord = await sendOperatorWaitingEmail(
      actorUrl,
      identity,
      { ...recordIdentityInput, item_record_id: null },
      { mail: identityMail, now: waitingNow },
    )
    const recordIdentityRows = await admin<
      {
        id: string
        item_record_id: string | null
        status: string
      }[]
    >`SELECT id::text,item_record_id::text,status FROM operator_waiting_email
      WHERE space_id=${SPACE_A}::uuid AND user_id=${USER}::uuid
        AND kind='question' AND item_id=943020 AND episode='item-record-identity'
      ORDER BY item_record_id NULLS LAST`
    if (
      [firstRecord, repeatedRecord, secondRecord, olderRecord, repeatedOlderRecord].some(
        (result) => result.status !== 'sent',
      ) ||
      repeatedRecord.id !== firstRecord.id ||
      repeatedOlderRecord.id !== olderRecord.id ||
      secondRecord.id === firstRecord.id ||
      olderRecord.id === firstRecord.id ||
      recordIdentityRows.length !== 3 ||
      recordIdentityRows.some((row) => row.status !== 'sent') ||
      JSON.stringify(recordIdentityRows.map((row) => row.item_record_id)) !==
        JSON.stringify([firstItemRecordId, secondItemRecordId, null])
    )
      throw new Error(
        `operator waiting item UUID claims were ${JSON.stringify({ firstRecord, repeatedRecord, secondRecord, olderRecord, repeatedOlderRecord, recordIdentityRows })}`,
      )

    const upgradedItemRecordId = '01990000-0000-7000-8000-000000000699'
    const legacyInput = {
      ...waitingInput,
      item_id: 943_021,
      item_record_id: null,
      episode: 'legacy-upgrade',
    }
    const legacy = await sendOperatorWaitingEmail(actorUrl, identity, legacyInput, {
      mail: identityMail,
      now: waitingNow,
    })
    const upgraded = await sendOperatorWaitingEmail(
      actorUrl,
      identity,
      { ...legacyInput, item_record_id: upgradedItemRecordId },
      { mail: identityMail, now: waitingNow },
    )
    const upgradeRows = await admin<
      { id: string; item_record_id: string | null; status: string }[]
    >`
      SELECT id::text,item_record_id::text,status FROM operator_waiting_email
      WHERE space_id=${SPACE_A}::uuid AND user_id=${USER}::uuid
        AND kind='question' AND item_id=943021 AND episode='legacy-upgrade'
      ORDER BY item_record_id NULLS LAST`
    if (
      legacy.status !== 'sent' ||
      upgraded.status !== 'sent' ||
      legacy.id === upgraded.id ||
      upgradeRows.length !== 2 ||
      upgradeRows.some((row) => row.status !== 'sent') ||
      JSON.stringify(upgradeRows.map((row) => row.item_record_id)) !==
        JSON.stringify([upgradedItemRecordId, null])
    )
      throw new Error(
        `operator waiting legacy upgrade claims were ${JSON.stringify({ legacy, upgraded, upgradeRows })}`,
      )

    const staleInput = { ...waitingInput, item_id: 943_002, episode: 'stale-intent' }
    const failed = await sendOperatorWaitingEmail(actorUrl, identity, staleInput, {
      mail: { send: async () => Promise.reject(new Error('stale fixture')) },
      now: waitingNow,
    })
    await admin`UPDATE operator_waiting_email SET status='intent',
      updated_at=${new Date(waitingNow.getTime() - 11 * 60_000).toISOString()}::timestamptz
      WHERE id=${failed.id}::uuid`
    const reclaimed = await sendOperatorWaitingEmail(actorUrl, identity, staleInput, {
      mail,
      now: waitingNow,
    })
    if (reclaimed.status !== 'sent' || sentCount() !== 2)
      throw new Error('stale operator waiting intent was not reclaimed')

    const cappedInput = { ...waitingInput, item_id: 943_003, episode: 'attempt-cap' }
    let capped = await sendOperatorWaitingEmail(actorUrl, identity, cappedInput, {
      mail: { send: async () => Promise.reject(new Error('cap fixture')) },
      now: waitingNow,
    })
    for (let attempt = 1; attempt < OPERATOR_EMAIL_MAX_ATTEMPTS; attempt++)
      capped = await sendOperatorWaitingEmail(actorUrl, identity, cappedInput, {
        mail: { send: async () => Promise.reject(new Error('cap fixture')) },
        now: new Date(waitingNow.getTime() + attempt),
      })
    if (capped.status !== 'failed') throw new Error('operator waiting attempt cap failed early')
    const abandoned = await sendOperatorWaitingEmail(actorUrl, identity, cappedInput, {
      mail,
      now: new Date(waitingNow.getTime() + OPERATOR_EMAIL_MAX_ATTEMPTS),
    })
    const cappedRows = await admin`SELECT attempts FROM operator_waiting_email
      WHERE id=${abandoned.id}::uuid`
    if (
      abandoned.status !== 'abandoned' ||
      Number(cappedRows[0]?.attempts) !== OPERATOR_EMAIL_MAX_ATTEMPTS ||
      sentCount() !== 2
    )
      throw new Error('operator waiting failed row was not abandoned at the attempt cap')

    const secondIdentity = { userId: SECOND_USER, spaceId: SPACE_A }
    for (let index = 0; index < OPERATOR_EMAIL_HOURLY_BUDGET; index++)
      await sendOperatorWaitingEmail(
        actorUrl,
        secondIdentity,
        { ...waitingInput, item_id: 944_000 + index, episode: `budget-${index}` },
        { mail: { send: async () => undefined }, now: waitingNow },
      )
    await sendOperatorWaitingEmail(
      actorUrl,
      secondIdentity,
      { ...waitingInput, item_id: 945_000, episode: 'over-budget' },
      { mail: { send: async () => undefined }, now: waitingNow },
    ).then(
      () => {
        throw new Error('operator waiting hourly budget accepted an extra send')
      },
      (error) => {
        if (!(error instanceof OperatorEmailBudgetExceededError)) throw error
      },
    )
    const mirrored: HostedTask = {
      id: '01990000-0000-7000-8000-00000000065d',
      key: 'DEV-700',
      project: PLATFORM_SLUG,
      project_name: PLATFORM_SLUG,
      projectId: PROJECT_A,
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
      next_document_number: 1,
    }
    await pushEvidence(actorUrl, identity, [
      { table: 'hub_task', id: mirrored.id, op: 'upsert', row: mirrored },
    ])
    await pushEvidence(actorUrl, identity, [
      { table: 'hub_task', id: mirrored.id, op: 'upsert', row: mirrored },
    ])
    const created = await createHostedTask(actorUrl, identity, {
      project: PLATFORM_SLUG,
      projectId: PROJECT_A,
      title: 'Allocated fixture',
    })
    if (created.key !== 'DEV-701') throw new Error(`task allocation returned ${created.key}`)
    const closedAt = new Date().toISOString()
    const closed = {
      ...created,
      status: 'done',
      status_category: 'done' as const,
      closed_at: closedAt,
      last_seen: closedAt,
      updated_at: closedAt,
    }
    await applyHostedPushChanges(
      actorUrl,
      identity,
      [
        {
          table: 'hub_task',
          id: created.id,
          op: 'upsert',
          row: closed,
          fields: ['status', 'status_category'],
        },
        {
          table: 'hub_task_status_event',
          id: newRecordId(),
          op: 'upsert',
          row: {
            id: newRecordId(),
            task_key: created.key,
            task_id: created.id,
            project_name: created.project_name,
            projectId: PROJECT_A,
            at: closedAt,
            from_status: created.status,
            to_status: 'done',
            created_at: closedAt,
            updated_at: closedAt,
            deleted_at: null,
          },
        },
      ].map((change) =>
        change.table === 'hub_task_status_event' ? { ...change, id: change.row.id } : change,
      ) as HostedPushChange[],
    )
    const document = await createHostedDocument(actorUrl, identity, created.key, {
      title: 'Disposable',
      version: 'v1',
    })
    if (!document) throw new Error('task document create did not find its task')
    await applyHostedPushChanges(actorUrl, identity, [
      { table: 'hub_task_document', id: document.id, op: 'delete' },
    ])
    const visible = await listAllHostedTasks(actorUrl, identity)
    if (visible.tasks.length !== 2) throw new Error('mirror re-push was not idempotent')
    if (visible.documents.some((row) => row.id === document.id))
      throw new Error('soft-deleted document was visible in the default list')
    if (visible.statusEvents.length !== 1)
      throw new Error('status patch did not append exactly one event')
    await admin`UPDATE hub_task SET next_document_number=9 WHERE id=${created.id}::uuid`
    await pushEvidence(actorUrl, identity, [
      {
        table: 'hub_task',
        id: closed.id,
        op: 'upsert',
        row: { ...closed, next_document_number: 2 },
      },
    ])
    const preservedDocumentCounter = (
      await admin<{ next_document_number: number }[]>`
        SELECT next_document_number FROM hub_task WHERE id=${created.id}::uuid
      `
    )[0]?.next_document_number
    if (preservedDocumentCounter !== 9)
      throw new Error(`task mirror lowered the document counter to ${preservedDocumentCounter}`)
    const collidingDocumentId = newRecordId()
    await pushEvidence(actorUrl, identity, [
      {
        table: 'hub_task_document',
        id: collidingDocumentId,
        op: 'upsert',
        row: {
          ...document,
          id: collidingDocumentId,
          task_id: created.id,
          deleted_at: null,
        },
      },
    ]).then(
      () => {
        throw new Error('task document mirror reused a soft-deleted document number')
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes(document.id) || !message.includes(collidingDocumentId)) throw error
      },
    )
    await pushIntervals(actorUrl, identity, [
      {
        ...interval,
        task_key: created.key,
        task_id: created.id,
        ref: 'orch:hosted-view-fixture',
        user_id: USER,
      },
    ])
    const hostedDone = await hostedFlightDone(
      actorUrl,
      identity,
      {
        name: 'done',
        hours: 720,
        filters: { agent: '', project: '', source: '' },
        projects: [
          {
            spaceId: SPACE_A,
            spaceName: 'Evidence A',
            name: PLATFORM_SLUG,
            keyPrefixes: ['DEV'],
          },
        ],
      },
      FIXED_CLOCK,
    )
    if (!hostedDone.data.rows.some((row) => row.key === created.key && row.runs.length === 1))
      throw new Error('hosted done adapter did not return the seeded task and interval')
    const detail = await hostedTaskDetail(actorUrl, identity, created.key)
    if (detail?.statusEvents.length !== 1 || detail.runs.length !== 1)
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
      (id,space_id,project_name,task_key,number,title,body,version,created_at,updated_at) VALUES
      (${legacyDocumentId}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${mirrored.key},1,'legacy','legacy','v1',${stamp}::timestamptz,${stamp}::timestamptz)`
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
    await pushEvidence(actorUrl, identity, [
      { table: 'hub_task', id: renamed.id, op: 'upsert', row: renamed },
    ])
    const repaired = await admin<{ key: string | null; id: string | null }[]>`
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

    if (await hostedTaskDetail(actorUrl, { userId: USER, spaceId: SPACE_B }, created.key))
      throw new Error('another space observed hosted task detail')
    const other = await listAllHostedTasks(actorUrl, { userId: USER, spaceId: SPACE_B })
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
          projectId: PROJECT_A,
          text: 'Existing note',
          area: null,
          anchors: '[]',
          sightings: 1,
          created_at: noteStamp,
          last_seen_at: noteStamp,
          stale_at: noteStamp,
          stale_reason: 'dropped: resolved',
          promoted_task: null,
          updated_at: noteStamp,
          deleted_at: null,
        },
      ],
      raiseProjects: [{ project: PLATFORM_SLUG, projectId: PROJECT_A, next: 2 }],
    })
    const allocatedNote = await createHostedNote(actorUrl, identity, {
      project: PLATFORM_SLUG,
      projectId: PROJECT_A,
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
    if (!allocatedNote) throw new Error('allocated note was missing after creation')
    if (allocatedNote.number !== 801)
      throw new Error(`note allocation returned ${allocatedNote.number}`)
    const allocatedBeforeMismatch = await getHostedNote(actorUrl, identity, allocatedNote.id)
    let crossProjectSameAsRefused = false
    try {
      await createHostedNote(actorUrl, identity, {
        project: 'other-project',
        projectId: PROJECT_A_OTHER,
        text: 'Must not change the original note',
        anchor: JSON.stringify({ project: 'other-project' }),
        sameAs: allocatedNote.id,
      })
    } catch (error) {
      crossProjectSameAsRefused = String((error as Error).message).includes(
        'belongs to another project',
      )
    }
    if (!crossProjectSameAsRefused)
      throw new Error('sameAs accepted a note owned by another project id')
    const allocatedAfterMismatch = await getHostedNote(actorUrl, identity, allocatedNote.id)
    if (allocatedAfterMismatch?.sightings !== allocatedBeforeMismatch?.sightings)
      throw new Error('a refused cross-project sameAs changed the note')
    await admin`CREATE OR REPLACE FUNCTION fail_hub_task_insert() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION ''forced task insert failure''; END'`
    await admin`CREATE TRIGGER fail_hub_task_insert BEFORE INSERT ON hub_task
      FOR EACH ROW EXECUTE FUNCTION fail_hub_task_insert()`
    let promotionFailed = false
    try {
      await promoteHostedNote(actorUrl, identity, allocatedNote.id, {
        title: 'Allocated note promotion',
      })
    } catch {
      promotionFailed = true
    }
    await admin`DROP TRIGGER fail_hub_task_insert ON hub_task`
    await admin`DROP FUNCTION fail_hub_task_insert()`
    if (!promotionFailed) throw new Error('forced promotion task insert did not fail')
    if ((await getHostedNote(actorUrl, identity, allocatedNote.id))?.promoted_task)
      throw new Error('failed promotion marked its note')
    const promoted = await promoteHostedNote(actorUrl, identity, allocatedNote.id, {
      title: 'Allocated note promotion',
    })
    if (!promoted) throw new Error('allocated note was missing during promotion')
    if (!promoted.task) throw new Error('promotion did not return its created task')
    if (promoted.note.promoted_task !== promoted.task.key)
      throw new Error('promotion did not create a task and mark its note')
    await mirrorHostedNotes(actorUrl, identity, {
      notes: [
        {
          id: '01990000-0000-7000-8000-00000000066e',
          number: 802,
          project: PLATFORM_SLUG,
          project_name: PLATFORM_SLUG,
          projectId: PROJECT_A,
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
        annotated: [],
        restored: [],
        deleted: ['01990000-0000-7000-8000-00000000066e'],
        confirmation: 1,
        cutoff,
      })
    } catch (error) {
      if (!String((error as Error).message).includes('local cache is behind the record'))
        throw error
      refusedResighted = true
    }
    if (!refusedResighted) throw new Error('reap of a re-sighted note was not refused')
    if (!(await getHostedNote(actorUrl, identity, '01990000-0000-7000-8000-00000000066e')))
      throw new Error('re-sighted note was deleted')
    await reapHostedNotes(actorUrl, identity, {
      stale: [],
      annotated: [],
      restored: [],
      deleted: ['01990000-0000-7000-8000-00000000066d'],
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
    const recipientColumns = await admin<
      { column_name: string; is_nullable: string }[]
    >`SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='hub_report_subscription_recipient'
        AND column_name IN ('user_id','email','unsubscribe_token') ORDER BY column_name`
    if (
      recipientColumns.length !== 3 ||
      recipientColumns.some((column) => column.is_nullable !== 'YES')
    )
      throw new Error('report email recipient columns did not migrate as nullable')
    const projectSubscriptionColumns = await admin<
      { column_name: string; is_nullable: string }[]
    >`SELECT column_name,is_nullable FROM information_schema.columns
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
      return tx<
        { table_name: string; moved: boolean; reached_by: string }[]
      >`SELECT * FROM record_move_project_space(
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
      { from: interval.start_at, to: interval.end_at, key: interval.end_at },
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
    // Production break watched: allow a space-bound read member to delete without the token setting.
    const readMemberDeletedRecipient = await client.begin(async (tx) => {
      await bindTenant(tx, { userId: READ_USER, spaceId: SPACE_A })
      return tx`DELETE FROM hub_report_subscription_recipient
        WHERE space_id=${SPACE_A}::uuid AND unsubscribe_token=${emailRows[1]!.unsubscribe_token}
        RETURNING id`
    })
    if (readMemberDeletedRecipient.length !== 0)
      throw new Error('read member deleted a report recipient without the unsubscribe capability')
    await admin`DELETE FROM membership
      WHERE space_id=${SPACE_A}::uuid AND user_id=${READ_USER}::uuid`
    await admin`DELETE FROM "user" WHERE id=${READ_USER}::uuid`
    // Production break watched: remove the token-capability branch from the recipient DELETE policy.
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
    await admin`UPDATE project SET name='renamed-project' WHERE id=${PROJECT_A}::uuid`
    await admin`UPDATE project SET name=${PLATFORM_SLUG} WHERE id=${PROJECT_A_OTHER}::uuid`
    const renamedProjectTask = await createHostedTask(actorUrl, identity, {
      project: PLATFORM_SLUG,
      projectId: PROJECT_A,
      title: 'Identity survives rename',
    })
    const renamedTaskIdentity = await admin`SELECT project_id::text project_id FROM hub_task
      WHERE id=${renamedProjectTask.id}::uuid`
    if (renamedTaskIdentity[0]?.project_id !== PROJECT_A)
      throw new Error('task creation resolved the stale name instead of the sent id')
    const renamedProjectSubscription = await createHostedReportSubscription(actorUrl, identity, {
      scope: { kind: 'project', project: PLATFORM_SLUG, projectId: PROJECT_A },
      cadence: 'daily',
      hour: 8,
      zone: 'America/New_York',
      recipientUserIds: [USER],
    })
    if (
      renamedProjectSubscription.project_id !== PROJECT_A ||
      renamedProjectSubscription.project_name !== 'renamed-project'
    )
      throw new Error('project report creation resolved the stale name instead of the sent id')
    const renamedProjectUpdate = await updateHostedReportSubscription(
      actorUrl,
      identity,
      renamedProjectSubscription.id,
      {
        scope: { kind: 'project', project: PLATFORM_SLUG, projectId: PROJECT_A },
        cadence: 'daily',
        hour: 9,
        zone: 'America/New_York',
        recipientUserIds: [USER],
        enabled: true,
      },
    )
    if (
      renamedProjectUpdate.project_id !== PROJECT_A ||
      renamedProjectUpdate.project_name !== 'renamed-project'
    )
      throw new Error('project report update resolved the stale name instead of the sent id')
    await unsubscribeHostedReportSubscription(actorUrl, identity, renamedProjectSubscription.id)
    await admin`UPDATE project SET name='other-project' WHERE id=${PROJECT_A_OTHER}::uuid`
    await admin`UPDATE project SET name=${PLATFORM_SLUG} WHERE id=${PROJECT_A}::uuid`
    const subscription = await createHostedReportSubscription(actorUrl, identity, {
      scope: { kind: 'project', project: PLATFORM_SLUG, projectId: PROJECT_A },
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
      scope: { kind: 'project', project: PLATFORM_SLUG, projectId: PROJECT_A },
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
    if (!pageNotes.notes.some((row) => row.number === allocatedNote.number))
      throw new Error('hosted notes page adapter did not return the seeded note')
    const pageRatio = await hostedRatio(actorUrl, identity, 14, FIXED_CLOCK)
    if (!pageRatio.days.some((row) => row.day === '2026-09-17'))
      throw new Error('hosted ratio adapter did not return the seeded day')
    const pageSpend = await hostedSpend(actorUrl, identity, 14, FIXED_CLOCK)
    if (!pageSpend.numerators.some((row) => row.name === 'codex'))
      throw new Error('hosted spend adapter did not return the seeded interval')
    const pageSettings = await hostedSettings(actorUrl, identity, [PLATFORM_SLUG])
    if (
      // Two sends of this space's subscription, plus the projects-scope skipped and partial test sends.
      pageSettings.sends.length !== 4 ||
      pageSettings.sends.filter((send) => Number(send.test) === 1).length !== 3 ||
      // USER, SECOND_USER and the D2 moderation owner remain members of SPACE_A here.
      pageSettings.members.length !== 3 ||
      pageSettings.subscriptions.length !== 1
    )
      throw new Error('hosted settings adapter did not return members, sends and subscriptions')
    const emptyNotes = await hostedNotes(actorUrl, otherIdentity, { stale: false })
    const emptyRatio = await hostedRatio(actorUrl, otherIdentity, 14, FIXED_CLOCK)
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
    const measureTaskId = '01990000-0000-7000-8000-000000000758'
    const measureIntervals: IntervalEvidence[] = [
      {
        id: '01990000-0000-7000-8000-000000000692',
        task_key: 'DEV-758',
        task_id: measureTaskId,
        project_name: PLATFORM_SLUG,
        projectId: PROJECT_A,
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
        id: '01990000-0000-7000-8000-000000000693',
        task_key: 'DEV-758',
        task_id: measureTaskId,
        project_name: PLATFORM_SLUG,
        projectId: PROJECT_A,
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
        id: '01990000-0000-7000-8000-000000000694',
        task_key: 'DEV-758',
        task_id: measureTaskId,
        project_name: PLATFORM_SLUG,
        projectId: PROJECT_A,
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
        id: '01990000-0000-7000-8000-000000000695',
        task_key: null,
        project_name: PLATFORM_SLUG,
        projectId: PROJECT_A,
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
    await pushEvidence(actorUrl, identity, [
      {
        table: 'hub_task',
        id: measureTaskId,
        op: 'upsert',
        row: {
          id: measureTaskId,
          key: 'DEV-758',
          project: PLATFORM_SLUG,
          project_name: PLATFORM_SLUG,
          projectId: PROJECT_A,
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
          next_document_number: 1,
        },
      },
    ])
    await pushIntervals(actorUrl, identity, measureIntervals)
    const doneAt = '2026-09-17T12:10:00.000Z'
    await admin`INSERT INTO hub_task_status_event
      (id,space_id,project_name,task_key,task_id,at,from_status,to_status,created_at,updated_at)
      VALUES
        (${newRecordId()}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},'DEV-758',${measureTaskId}::uuid,
          ${doneAt}::timestamptz,'open','done',${doneAt}::timestamptz,${doneAt}::timestamptz),
        (${newRecordId()}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},'DEV-758',${measureTaskId}::uuid,
          ${'2026-09-17T12:50:00.000Z'}::timestamptz,'open','done',
          ${'2026-09-17T12:50:00.000Z'}::timestamptz,${'2026-09-17T12:50:00.000Z'}::timestamptz)`
    const loaded = await loadHostedMeasureRows(actorUrl, identity, measureWindow)
    const pure = computeMeasures(loaded, measureWindow, { kind: 'space' })
    const hosted = await hostedMeasures(actorUrl, identity, measureWindow, { kind: 'space' })
    if (JSON.stringify(pure) !== JSON.stringify(hosted))
      throw new Error('hosted measures differed from the pure function on the same rows')
    if (hosted.hoursRunning.unionMs !== 90 * 60_000)
      throw new Error(
        `hosted hours running merged overlapping orchestrator as ${hosted.hoursRunning.unionMs}`,
      )
    if (hosted.agentHours.sumMs <= hosted.hoursRunning.unionMs)
      throw new Error('hosted agent-hours did not keep overlapping orchestrator spans')
    if (!('shipped' in hosted) || hosted.shipped.count !== 1)
      throw new Error('shipped counted a task more than once after two done entries')
    const otherMeasures = await hostedMeasures(actorUrl, otherIdentity, measureWindow, {
      kind: 'space',
    })
    if (
      otherMeasures.hoursRunning.unionMs !== 0 ||
      otherMeasures.agentHours.sumMs !== 0 ||
      otherMeasures.sessionTime.unionThenSumMs !== 0 ||
      !('shipped' in otherMeasures) ||
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
      (id,space_id,project_name,task_key,number,title,body,version,created_at,updated_at) VALUES
      (${newRecordId()}::uuid,${SPACE_A}::uuid,${PLATFORM_SLUG},${pruneKey},1,'by key','body','v1',
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

    const aboveInt32 = 2_147_483_648
    const wideDay = {
      ...day,
      id: newRecordId(),
      day: '2026-09-20',
      claude_tokens: aboveInt32,
      cache_read: aboveInt32,
      canon_tokens: aboveInt32,
      other_tokens: aboveInt32,
    }
    const wideInterval = {
      ...interval,
      id: newRecordId(),
      start_at: '2026-09-20T12:00:00.000Z',
      end_at: '2026-09-20T12:05:00.000Z',
      claude_tokens: aboveInt32,
      vendor_tokens: aboveInt32,
      ref: 'orch:wide-token-proof',
    }
    await pushDays(actorUrl, identity, [wideDay])
    await pushIntervals(actorUrl, identity, [wideInterval])
    const wideRows = await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${USER}, true)`
      await tx`SELECT set_config('app.space_id', ${SPACE_A}, true)`
      return tx<
        {
          day_claude_tokens: string | number
          cache_read: string | number
          canon_tokens: string | number
          other_tokens: string | number
          interval_claude_tokens: string | number
          vendor_tokens: string | number
        }[]
      >`SELECT d.claude_tokens AS day_claude_tokens,d.cache_read,d.canon_tokens,d.other_tokens,
          i.claude_tokens AS interval_claude_tokens,i.vendor_tokens
        FROM hub_day d CROSS JOIN hub_interval i
        WHERE d.id=${wideDay.id}::uuid AND i.id=${wideInterval.id}::uuid`
    })
    const wide = wideRows[0]
    if (
      !wide ||
      Number(wide.day_claude_tokens) !== aboveInt32 ||
      Number(wide.cache_read) !== aboveInt32 ||
      Number(wide.canon_tokens) !== aboveInt32 ||
      Number(wide.other_tokens) !== aboveInt32 ||
      Number(wide.interval_claude_tokens) !== aboveInt32 ||
      Number(wide.vendor_tokens) !== aboveInt32
    )
      throw new Error('widened token columns did not round-trip above the 32-bit range')
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
  await admin`DELETE FROM operator_waiting_email WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM seq WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM project WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM record_change WHERE space_id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM space WHERE id IN (${SPACE_A}::uuid, ${SPACE_B}::uuid, ${SPACE_C}::uuid)`
  await admin`DELETE FROM machine WHERE id=${MACHINE}::uuid`
  await admin`DELETE FROM "user" WHERE id IN (${USER}::uuid, ${SECOND_USER}::uuid, ${READ_USER}::uuid,
    ${OUTSIDE_USER}::uuid, ${OTHER_OUTSIDE_USER}::uuid, ${OWNER_USER}::uuid)`
  await admin.close()
  await boundedActorUrl.close()
}
