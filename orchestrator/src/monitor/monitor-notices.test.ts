import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { BOARD_CACHE_OWNER_KEY } from '../board/board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from '../board/board-mode.ts'
import { postNotice } from '../board/board-service.ts'
import { db } from '../database/db.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import {
  claimMonitorNoticesWithHosted,
  markMonitorNoticesDeliveredWithHosted,
} from './monitor-notices.ts'

beforeEach(() => {
  process.env.ORCH_RECORD_API_URL = 'https://record.test'
})
afterEach(() => {
  installRecordApiClient(null)
  delete process.env.ORCH_RECORD_API_URL
})

test('monitor notice and interrupt claims emit hosted beside local once with a failed-refresh warning', async () => {
  const session = 'monitor-hosted-reader'
  const userId = newRecordId()
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db()
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run('board_hosted_signed_in_user', userId)
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_CACHE_OWNER_KEY, userId)
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude','architect','machine','monitor-project','/tmp',NULL,?,?)`,
    )
    .run(session, '2026-10-05T11:00:00.000Z', new Date().toISOString())
  const local = postNotice(
    {
      audience: `session:${session}`,
      title: 'Local interrupt',
      body: 'local monitor body',
      ackRequired: true,
    },
    {},
    Date.parse('2026-10-05T12:00:00.000Z'),
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
    createdAt: '2026-10-05T12:00:00.000Z',
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
    ackRequired: true,
    ackDeadline: null,
  }
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(hosted.id, hosted.kind, null, hosted.revision, JSON.stringify(hosted))
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => {
      throw new Error('monitor refresh offline\nForged-Warning: monitor')
    },
    putBoardReceipt: async () => {
      throw new Error('receipt offline')
    },
  })
  const delivery = await claimMonitorNoticesWithHosted(session)
  expect(delivery.notices.map((row) => row.noticeId)).toEqual([
    `board:${local.id}`,
    `board:${hosted.id}`,
  ])
  expect(delivery.warning).toContain('monitor refresh offline')
  expect(delivery.warning).toContain('offline Forged-Warning: monitor')
  expect(delivery.warning).not.toContain('\n')
  await markMonitorNoticesDeliveredWithHosted(
    session,
    delivery.notices.map((row) => row.noticeId),
  )
  expect((await claimMonitorNoticesWithHosted(session)).notices).toEqual([])
})

test('session-start monitor skips hosted refresh while the heartbeat monitor refreshes', async () => {
  const session = 'monitor-refresh-reader'
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude','architect','machine','monitor-project','/tmp',NULL,?,?)`,
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
  await claimMonitorNoticesWithHosted(session, { refreshBoard: false })
  expect(changesCalls).toBe(0)
  await claimMonitorNoticesWithHosted(session)
  expect(changesCalls).toBe(1)
})

test('an unadopted mixed condition and local-board acknowledgement succeeds without a hosted call', async () => {
  const session = 'monitor-local-reader'
  db().query('DELETE FROM schema_meta WHERE key=?').run(BOARD_HOSTED_ADOPTED_KEY)
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude','architect','machine','monitor-project','/tmp',NULL,?,?)`,
    )
    .run(session, '2026-10-05T11:00:00.000Z', new Date().toISOString())
  const invocation = (
    db()
      .query(
        `INSERT INTO monitor_invocation(started_at,finished_at,trigger,findings,errors)
         VALUES (?,?, 'invoked',1,0) RETURNING id`,
      )
      .get('2026-10-05T12:00:00.000Z', '2026-10-05T12:00:01.000Z') as { id: number }
  ).id
  const condition = (
    db()
      .query(
        `INSERT INTO monitor_condition
         (invocation_id,kind,subject,condition_since,age_ms,detail,action,owner_session_id)
         VALUES (?,'stale-run','run:7',?,1000,'detail','reported',?) RETURNING id`,
      )
      .get(invocation, '2026-10-05T11:59:59.000Z', session) as { id: number }
  ).id
  const local = postNotice(
    {
      audience: `session:${session}`,
      title: 'Local interrupt',
      body: 'local monitor body',
      ackRequired: true,
    },
    {},
    Date.parse('2026-10-05T12:00:00.000Z'),
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
    markMonitorNoticesDeliveredWithHosted(session, [
      `condition:${condition}`,
      `board:${local.id}`,
      'board:not-an-id',
    ]),
  ).resolves.toBeUndefined()
  expect(hostedCalls).toBe(0)
  expect(
    db().query('SELECT delivered_at FROM monitor_condition WHERE id=?').get(condition),
  ).toEqual({
    delivered_at: expect.any(String),
  })
  expect(
    db()
      .query('SELECT delivered_at FROM board_receipt WHERE message_id=? AND reader_session=?')
      .get(local.id, session),
  ).toEqual({ delivered_at: expect.any(String) })
})
