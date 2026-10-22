import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { BOARD_CACHE_OWNER_KEY } from '../board/board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from '../board/board-mode.ts'
import { postNotice } from '../board/board-service.ts'
import { renderBoardReplyDelivery } from '../board/board-thread-render.ts'
import { askQuestion, replyToThread } from '../board/board-thread-service.ts'
import { DB_PATH, db } from '../database/db.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import {
  claimMonitorNoticesWithHosted,
  markMonitorNoticesDeliveredWithHosted,
  refreshMonitorHostedBoard,
} from './monitor-notices.ts'

const createdAt = new Date(Date.now() - 1_000).toISOString()

beforeEach(() => {
  process.env.ORCH_RECORD_API_URL = 'https://record.test'
})
afterEach(() => {
  installRecordApiClient(null)
  delete process.env.ORCH_RECORD_API_URL
})

test('heartbeat delivery emits ordinary hosted beside local once with a failed-refresh warning', async () => {
  const session = 'monitor-hosted-reader'
  const userId = newRecordId()
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db()
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run('board_hosted_signed_in_user', userId)
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_CACHE_OWNER_KEY, userId)
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude','architect','machine','monitor-project',(SELECT record_id FROM project WHERE name='monitor-project'),'/tmp',NULL,?,?)`,
    )
    .run(session, '2026-10-05T11:00:00.000Z', new Date().toISOString())
  const local = postNotice(
    {
      audience: `session:${session}`,
      title: 'Local interrupt',
      body: 'local monitor body',
      ackRequired: false,
    },
    {},
    Date.parse(createdAt),
  )
  const hosted: HostedBoardMessage = {
    id: newRecordId(),
    kind: 'notice',
    threadRootId: null,
    title: 'Hosted interrupt',
    body: 'hosted monitor body',
    audience: `session:${session}`,
    origin: {
      kind: 'operator',
      session: null,
      harness: null,
      project: 'monitor-project',
      runId: null,
    },
    senderTags: [],
    createdAt,
    expiresAt: '2099-01-01T00:00:00.000Z',
    withdrawnAt: null,
    state: 'open',
    acceptedReplyId: null,
    acceptedBy: null,
    acceptedAt: null,
    noteId: null,
    notePendingError: null,
    revision: '1',
    scopeProjectIds: [],
    recipientUserIds: [],
    claimId: null,
    authorUserId: userId,
    authorSession: null,
    ackRequired: false,
    ackDeadline: null,
  }
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(hosted.id, hosted.kind, null, hosted.revision, JSON.stringify(hosted))
  let refreshFails = true
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => {
      if (refreshFails) throw new Error('monitor refresh offline\nForged-Warning: monitor')
      return { userId, items: [], highestRevision: null }
    },
    putBoardReceipt: async () => {
      throw new Error('receipt offline')
    },
  })
  const delivery = await claimMonitorNoticesWithHosted(session, await refreshMonitorHostedBoard())
  expect(delivery.notices.map((row) => row.noticeId)).toEqual([
    `board:${local.number}`,
    `board:${hosted.id}`,
  ])
  expect(delivery.warning).toContain('monitor refresh offline')
  expect(delivery.warning).toContain('offline Forged-Warning: monitor')
  expect(delivery.warning).not.toContain('\n')
  await markMonitorNoticesDeliveredWithHosted(
    session,
    delivery.notices.map((row) => row.noticeId),
  )
  const measured = db()
    .query(
      `SELECT delivery_point,COUNT(DISTINCT emission_id) emissions,COUNT(*) messages
       FROM board_reach_delivery GROUP BY delivery_point`,
    )
    .get()
  expect(measured).toEqual({ delivery_point: 'heartbeat-monitor', emissions: 1, messages: 2 })
  const repeatedFailure = await claimMonitorNoticesWithHosted(
    session,
    await refreshMonitorHostedBoard(),
  )
  expect(repeatedFailure.notices).toEqual([])
  expect(repeatedFailure.warning).toBeNull()
  refreshFails = false
  const recovery = await claimMonitorNoticesWithHosted(session, await refreshMonitorHostedBoard())
  expect(recovery.notices).toEqual([])
  expect(recovery.warning).toContain('Hosted board cache is verified again')
  const verified = await claimMonitorNoticesWithHosted(session, await refreshMonitorHostedBoard())
  expect(verified.notices).toEqual([])
  expect(db().query('SELECT COUNT(*) count FROM board_reach_delivery').get()).toEqual({ count: 2 })
  expect(verified.warning).toBeNull()
})

test('notice claim is read-only and hosted refresh is an explicit write step', async () => {
  const session = 'monitor-refresh-reader'
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude','architect','machine','monitor-project',(SELECT record_id FROM project WHERE name='monitor-project'),'/tmp',NULL,?,?)`,
    )
    .run(session, '2026-10-05T11:00:00.000Z', new Date().toISOString())
  let changesCalls = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => {
      changesCalls++
      return { userId: newRecordId(), items: [], highestRevision: null }
    },
  })
  await claimMonitorNoticesWithHosted(session)
  expect(changesCalls).toBe(0)
  await refreshMonitorHostedBoard()
  expect(changesCalls).toBe(1)
})

test('notice claim succeeds while another connection holds the store writer', async () => {
  const session = 'monitor-reader-during-writer'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude','architect','machine','monitor-project',(SELECT record_id FROM project WHERE name='monitor-project'),'/tmp',NULL,?,?)`,
    )
    .run(session, '2026-10-05T11:00:00.000Z', new Date().toISOString())
  const local = postNotice(
    {
      audience: `session:${session}`,
      title: 'Available during writer',
      body: 'read-only claim body',
      ackRequired: false,
    },
    {},
    Date.now(),
  )
  const writer = new Database(DB_PATH, { readwrite: true })
  writer.exec('BEGIN IMMEDIATE')
  try {
    const delivery = await claimMonitorNoticesWithHosted(session)
    expect(delivery.notices.map((notice) => notice.noticeId)).toContain(`board:${local.number}`)
  } finally {
    writer.exec('ROLLBACK')
    writer.close()
  }
})

test('heartbeat board notices use the shared reply delivery rendering', async () => {
  const clock = Date.now()
  const reader = 'monitor-reply-reader'
  const postingCwd = resolve(import.meta.dir, '../../..')
  db()
    .query(
      `INSERT INTO project(record_id,name,path,settings)
       VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'monitor-project',?,'{}')`,
    )
    .run(postingCwd)
  for (const session of [reader, 'monitor-thread-author'])
    db()
      .query(
        `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
         VALUES (?,'claude-code','architect','test','monitor-project',(SELECT record_id FROM project WHERE name='monitor-project'),'/tmp',NULL,?,?)`,
      )
      .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const question = askQuestion(
    { audience: `session:${reader}`, title: 'Monitor thread', body: 'root body' },
    { CLAUDE_CODE_SESSION_ID: 'monitor-thread-author' },
    clock,
    postingCwd,
  )
  replyToThread(
    question.recordId,
    'reader participated',
    { CLAUDE_CODE_SESSION_ID: reader },
    clock + 1,
    postingCwd,
  )
  const reply = replyToThread(
    question.recordId,
    'reply body',
    { CLAUDE_CODE_SESSION_ID: 'monitor-thread-author' },
    clock + 2,
    postingCwd,
  )

  const delivery = await claimMonitorNoticesWithHosted(reader)
  const replyNotice = delivery.notices.find((notice) => notice.noticeId === `board:${reply.number}`)
  expect(replyNotice?.detail).toBe(
    renderBoardReplyDelivery({
      origin: 'architect monitor-thread-author (claude-code, monitor-project)',
      rootId: question.recordId,
      rootTitle: 'Monitor thread',
      body: 'reply body',
    }),
  )
  expect(replyNotice?.detail).not.toContain('root body')
})

test('an unadopted mixed condition and local-board acknowledgement succeeds without a hosted call', async () => {
  const session = 'monitor-local-reader'
  db().query('DELETE FROM schema_meta WHERE key=?').run(BOARD_HOSTED_ADOPTED_KEY)
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude','architect','machine','monitor-project',(SELECT record_id FROM project WHERE name='monitor-project'),'/tmp',NULL,?,?)`,
    )
    .run(session, '2026-10-05T11:00:00.000Z', new Date().toISOString())
  const invocation = (
    db()
      .query(
        `INSERT INTO monitor_invocation(record_id,started_at,finished_at,trigger,findings,errors)
         VALUES (?,?,?, 'invoked',1,0) RETURNING id`,
      )
      .get(newRecordId(), '2026-10-05T12:00:00.000Z', '2026-10-05T12:00:01.000Z') as {
      id: number
    }
  ).id
  const condition = (
    db()
      .query(
        `INSERT INTO monitor_condition
         (record_id,invocation_id,kind,subject,condition_since,age_ms,detail,action,owner_session_id)
         VALUES (?,?,'stale-run','run:7',?,1000,'detail','reported',?) RETURNING id`,
      )
      .get(newRecordId(), invocation, '2026-10-05T11:59:59.000Z', session) as { id: number }
  ).id
  const local = postNotice(
    {
      audience: `session:${session}`,
      title: 'Local interrupt',
      body: 'local monitor body',
      ackRequired: true,
      purpose: 'request',
    },
    {},
    Date.now(),
  )
  let hostedCalls = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    putBoardReceipt: async () => {
      hostedCalls++
      throw new Error('must not call')
    },
  })

  await expect(
    markMonitorNoticesDeliveredWithHosted(
      session,
      [`condition:${condition}`, `board:${local.number}`, 'board:not-an-id'],
      new Date().toISOString(),
    ),
  ).resolves.toBeUndefined()
  expect(hostedCalls).toBe(0)
  expect(
    db().query('SELECT delivered_at FROM monitor_condition WHERE id=?').get(condition),
  ).toEqual({
    delivered_at: expect.any(String),
  })
  expect(
    db()
      .query(
        'SELECT delivered_at FROM board_receipt WHERE message_record_id=? AND reader_session=?',
      )
      .get(local.recordId, session),
  ).toEqual({ delivered_at: expect.any(String) })
})
