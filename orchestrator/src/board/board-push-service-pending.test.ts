import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import { boardAcknowledge, boardStatus } from './board-operations.ts'
import { pendingBoardDelivery } from './board-push-service.ts'
import { acknowledgeNotice, postNotice } from './board-service.ts'

test('pending acknowledgement resolution combines local and hosted cache and excludes acknowledged or unaddressed notices', async () => {
  const clock = Date.parse('2026-10-07T12:00:00.000Z')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
     VALUES ('push-reader','claude-code','architect','test','push-project',(SELECT record_id FROM project WHERE name='push-project'),'/tmp',NULL,?,?)`,
    )
    .run(new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const local = postNotice(
    {
      audience: 'project:push-project',
      title: 'Local',
      body: 'Local body',
      ackRequired: true,
      deadlineMs: 30_000,
      purpose: 'request',
    },
    {},
    clock,
  )
  const olderLocal = postNotice(
    {
      audience: 'project:push-project',
      title: 'Older local',
      body: 'Do not ask this reader to acknowledge.',
      ackRequired: true,
      deadlineMs: 30_000,
      purpose: 'request',
    },
    {},
    clock - 2_000,
  )
  postNotice(
    {
      audience: 'project:push-project',
      title: 'Older standing local',
      body: 'Acknowledge this standing rule.',
      ackRequired: true,
      deadlineMs: 30_000,
      purpose: 'standing',
    },
    {},
    clock - 2_000,
  )
  const acknowledged = postNotice(
    {
      audience: 'project:push-project',
      title: 'Done',
      body: 'Done body',
      ackRequired: true,
      purpose: 'request',
    },
    {},
    clock + 1,
  )
  acknowledgeNotice(acknowledged.recordId, { CLAUDE_CODE_SESSION_ID: 'push-reader' }, clock + 2)
  const setMeta = db().query(
    'INSERT INTO schema_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  )
  setMeta.run('board_hosted_cache_owner', 'user-1')
  setMeta.run('board_hosted_signed_in_user', 'user-1')
  const hosted = {
    id: '01990000-0000-7000-8000-000000000111',
    kind: 'notice',
    threadRootId: null,
    title: 'Hosted',
    body: 'Hosted body',
    audience: 'project:push-project',
    origin: {
      kind: 'operator',
      session: null,
      harness: null,
      project: null,
      runId: null,
    },
    senderTags: [],
    createdAt: new Date(clock).toISOString(),
    expiresAt: new Date(clock + 60_000).toISOString(),
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
    authorUserId: 'user-1',
    authorSession: null,
    ackRequired: true,
    purpose: 'request',
    ackDeadline: new Date(clock + 30_000).toISOString(),
  }
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(hosted.id, hosted.kind, null, hosted.revision, JSON.stringify(hosted))
  const olderHosted = {
    ...hosted,
    id: '01990000-0000-7000-8000-000000000112',
    title: 'Older hosted',
    createdAt: new Date(clock - 2_000).toISOString(),
  }
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(olderHosted.id, olderHosted.kind, null, olderHosted.revision, JSON.stringify(olderHosted))
  const olderStandingHosted = {
    ...olderHosted,
    id: '01990000-0000-7000-8000-000000000113',
    title: 'Older standing hosted',
    purpose: 'standing',
  }
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(
      olderStandingHosted.id,
      olderStandingHosted.kind,
      null,
      olderStandingHosted.revision,
      JSON.stringify(olderStandingHosted),
    )

  const pending = await pendingBoardDelivery({
    session: 'push-reader',
    budgetMs: 1,
    clock: clock + 3,
  })
  expect(pending.delivery.map((notice) => notice.id).sort()).toEqual(
    [String(local.number), hosted.id].sort(),
  )
  expect(pending.pendingAcknowledgements.map((notice) => notice.id).sort()).toEqual(
    [String(local.number), hosted.id].sort(),
  )
  expect(pending.delivery.map((notice) => notice.id)).not.toContain(String(olderLocal.number))
  expect(pending.pendingAcknowledgements.map((notice) => notice.id)).not.toContain(olderHosted.id)

  const afterDeadline = await pendingBoardDelivery({
    session: 'push-reader',
    budgetMs: 0,
    clock: clock + 30_001,
  })
  expect(afterDeadline.pendingAcknowledgements).toEqual([])
  expect(afterDeadline.delivery).toEqual([])
})

test('a hosted acknowledgement immediately clears delivery from verified or unverified cache state', async () => {
  const clock = Date.parse('2026-10-15T13:54:00.000Z')
  const session = 'hosted-ack-reader'
  const userId = newRecordId()
  const messageId = newRecordId()
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test',?,(SELECT record_id FROM project WHERE name=?),'/tmp',NULL,?,?)`,
    )
    .run(
      session,
      PLATFORM_SLUG,
      PLATFORM_SLUG,
      new Date(clock - 1_000).toISOString(),
      new Date(clock).toISOString(),
    )
  const setMeta = db().query(
    'INSERT INTO schema_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  )
  setMeta.run(BOARD_HOSTED_ADOPTED_KEY, '1')
  setMeta.run('board_hosted_cache_owner', userId)
  setMeta.run('board_hosted_signed_in_user', userId)
  const message = {
    id: messageId,
    kind: 'notice',
    purpose: 'standing',
    threadRootId: null,
    title: 'Standing notice',
    body: 'Acknowledge this notice.',
    audience: `session:${session}`,
    audienceDescription: `session:${session}`,
    origin: {
      kind: 'architect',
      session: 'posting-session',
      harness: 'claude-code',
      project: PLATFORM_SLUG,
      projectStored: true,
      runId: null,
    },
    senderTags: [],
    createdAt: new Date(clock).toISOString(),
    expiresAt: new Date(clock + 60_000).toISOString(),
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
    authorSession: 'posting-session',
    ackRequired: true,
    ackDeadline: new Date(clock + 30_000).toISOString(),
  }
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(message.id, message.kind, null, message.revision, JSON.stringify(message))
  const client = {
    ...createMemoryRecordApiClient(),
    putBoardReceipt: async (
      input: Parameters<ReturnType<typeof createMemoryRecordApiClient>['putBoardReceipt']>[0],
    ) => ({
      messageId: input.messageId,
      readerUserId: userId,
      readerSession: input.readerSession,
      audienceAtPosting: input.audienceAtPosting,
      deliveredAt: null,
      acknowledgedAt: new Date(clock + 1).toISOString(),
    }),
  }
  // The session already holds a delivered, unacknowledged receipt, as in the reported incident.
  db()
    .query(
      `INSERT INTO hosted_board_receipt_cache
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,pending_sync)
       VALUES (?,?,1,?,NULL,0)`,
    )
    .run(message.id, session, new Date(clock - 500).toISOString())

  await boardAcknowledge(message.id, {
    env: { CLAUDE_CODE_SESSION_ID: session, ORCH_RECORD_API_URL: 'https://record.test' },
    client,
  })
  for (const outcome of ['success', 'failed: hosted board refresh budget spent']) {
    setMeta.run('board_hosted_refresh_outcome', outcome)
    const pending = await pendingBoardDelivery({ session, budgetMs: 0, clock: clock + 2 })
    expect(pending.delivery).toEqual([])
    expect(pending.pendingAcknowledgements).toEqual([])
  }
})

test('hosted status never counts the notice author as unacknowledged', async () => {
  const authorUserId = newRecordId()
  const message = {
    id: newRecordId(),
    kind: 'notice',
    purpose: 'standing' as const,
    threadRootId: null,
    title: 'Standing notice',
    body: 'body',
    audience: 'architects:all',
    origin: {
      kind: 'architect',
      session: 'posting-session',
      harness: 'claude-code',
      project: PLATFORM_SLUG,
      projectStored: true,
      runId: null,
    },
    senderTags: [],
    createdAt: '2026-10-15T13:53:00.000Z',
    expiresAt: '2026-10-16T13:53:00.000Z',
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
    authorUserId,
    authorSession: 'posting-session',
    ackRequired: true,
    ackDeadline: '2026-10-16T13:53:00.000Z',
  }
  const authorReceipt = {
    messageId: message.id,
    readerUserId: authorUserId,
    readerSession: 'posting-session',
    audienceAtPosting: true,
    deliveredAt: null,
    acknowledgedAt: null,
  }
  const readerReceipt = {
    ...authorReceipt,
    readerUserId: newRecordId(),
    readerSession: 'other-reader',
  }
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const status = await boardStatus(message.id, {
    env: { CLAUDE_CODE_SESSION_ID: 'posting-session', ORCH_RECORD_API_URL: 'https://record.test' },
    client: {
      ...createMemoryRecordApiClient(),
      getBoardStatus: async () => ({ message, receipts: [authorReceipt, readerReceipt] }),
    },
  })
  expect(status.unacknowledged).toEqual(['other-reader'])
})
