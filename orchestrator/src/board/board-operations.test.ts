import { beforeEach, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import {
  boardAccept,
  boardAcknowledge,
  boardAsk,
  boardClaimList,
  boardClaimRelease,
  boardClaimRenew,
  boardClaimTake,
  boardFileNote,
  boardPost,
  boardReply,
  boardStatus,
  boardThread,
  boardWithdraw,
} from './board-operations.ts'
import { pendingBoardDelivery } from './board-push-service.ts'
import { postNotice } from './board-service.ts'
import { originText } from './board-store.ts'
import { askQuestion, replyToThread } from './board-thread-service.ts'

const env = {
  CLAUDE_CODE_SESSION_ID: 'board-route-session',
  ORCH_RECORD_API_URL: 'https://record.test',
}
const noRecordEnv = {
  [CONFIG_HOME_ENV]: '/definitely-missing-config',
  [HARNESS_ENV_FILE_ENV]: '',
}
const postingCwd = resolve(import.meta.dir, '../../..')

const hostedMessage = (id = newRecordId()) => ({
  id,
  kind: 'notice',
  threadRootId: null,
  title: 'Hosted',
  body: 'body',
  audience: 'operator',
  origin: {
    kind: 'architect',
    session: 'board-route-session',
    harness: 'claude',
    project: null,
    runId: null,
  },
  senderTags: [],
  createdAt: '2026-10-05T12:00:00.000Z',
  expiresAt: '2026-10-06T12:00:00.000Z',
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
  authorUserId: newRecordId(),
  authorSession: 'board-route-session',
  ackRequired: false,
  ackDeadline: null,
})

beforeEach(() => {
  db().query('DELETE FROM schema_meta WHERE key=?').run(BOARD_HOSTED_ADOPTED_KEY)
  db().query('DELETE FROM board_message').run()
  db().query('DELETE FROM board_claim').run()
  db()
    .query(
      "INSERT OR IGNORE INTO project(name,path,settings) VALUES ('board-route-project','/tmp/board-route-project','{}')",
    )
    .run()
  db()
    .query(
      "INSERT OR IGNORE INTO project(name,path,settings) VALUES ('board-route-architect',?,'{}')",
    )
    .run(process.cwd())
})

test('an unadopted install keeps a post local and renders its id as a string', async () => {
  const result = await boardPost(
    { audience: 'operator', title: 'Local', body: 'unchanged' },
    {
      env: { ORCH_RECORD_API_URL: env.ORCH_RECORD_API_URL },
      clock: Date.parse('2026-10-05T12:00:00Z'),
      cwd: process.cwd(),
    },
  )
  expect(result.id).toBeString()
  expect(result).toEqual({
    id: result.id,
    dropped: false,
    reached: 1,
    warning: null,
  })
  expect(
    db().query<{ count: number }, []>('SELECT count(*) count FROM board_message').get()?.count,
  ).toBe(1)
})

test('hosted post and reply expose unavailable posting counts as null', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const root = hostedMessage()
  const reply = hostedMessage()
  const client = {
    ...createMemoryRecordApiClient(),
    postBoardMessage: async () => root,
    replyBoardMessage: async () => reply,
  }
  await expect(
    boardPost({ audience: 'operator', title: 'Hosted', body: 'body' }, { env, client }),
  ).resolves.toEqual({ id: root.id, dropped: false, reached: null, warning: null })
  await expect(boardReply(root.id, 'reply', { env, client })).resolves.toEqual({
    id: reply.id,
    rootId: root.id,
    dropped: false,
    reached: null,
    warning: null,
  })
})

test('local and hosted note filing render one common origin shape', () => {
  expect(
    originText({
      kind: 'architect',
      session: 'origin-session',
      harness: 'claude',
      project: 'fixture',
      runId: null,
    }),
  ).toBe('architect origin-session (claude, fixture)')
  expect(
    originText({
      kind: 'worker',
      session: null,
      harness: 'codex',
      project: 'fixture',
      runId: '01990000-0000-7000-8000-000000000001',
    }),
  ).toBe('worker run 01990000-0000-7000-8000-000000000001')
})

test('thread results have one pinned shape in local and hosted modes', async () => {
  const clock = Date.parse('2026-10-05T12:00:00Z')
  const question = await boardAsk(
    { audience: 'operator', title: 'Local question', body: 'Question body' },
    { env: noRecordEnv, clock },
  )
  db()
    .query('UPDATE board_message SET note_record_id=?,note_label=? WHERE id=?')
    .run('01990000-0000-7000-8000-000000000042', 'fixture#42', Number(question.id))
  const local = await boardThread(question.id, { env: noRecordEnv, clock })
  expect(local).toEqual({
    root: {
      id: question.id,
      kind: 'question',
      threadRootId: null,
      title: 'Local question',
      body: 'Question body',
      audience: 'operator',
      origin: { kind: 'operator', session: null, harness: null, project: null, runId: null },
      senderTags: [],
      createdAt: '2026-10-05T12:00:00.000Z',
      expiresAt: '2026-10-06T12:00:00.000Z',
      withdrawnAt: null,
      state: 'open',
      acceptedReplyId: null,
      acceptedBy: null,
      acceptedAt: null,
      noteRecordId: '01990000-0000-7000-8000-000000000042',
      noteLabel: 'fixture#42',
      notePendingError: null,
      revision: null,
      scopeProjectIds: null,
      recipientUserIds: null,
      claimId: null,
      authorUserId: null,
      authorSession: null,
      ackRequired: null,
      ackDeadline: null,
      text: null,
    },
    replies: [],
  })

  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const unresolvedNoteId = '01990000-0000-7000-8000-000000000099'
  const message = { ...hostedMessage(), noteId: unresolvedNoteId }
  const hosted = await boardThread(message.id, {
    env,
    client: {
      ...createMemoryRecordApiClient(),
      getBoardThread: async () => ({ root: message, replies: [] }),
    },
  })
  const { noteId: _noteId, ...hostedRoot } = message
  expect(hosted).toEqual({
    root: { ...hostedRoot, noteRecordId: unresolvedNoteId, noteLabel: null, text: null },
    replies: [],
  })
})

test('reading a thread stamps its printed root and replies while acknowledgement remains pending', async () => {
  db()
    .query(`INSERT OR IGNORE INTO project(name,path,settings) VALUES ('push-project',?,'{}')`)
    .run(postingCwd)
  const clock = Date.parse('2026-10-08T13:00:00.000Z')
  const session = 'thread-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','push-project','/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const question = askQuestion(
    { audience: `session:${session}`, title: 'Read thread', body: 'Question body' },
    { CLAUDE_CODE_SESSION_ID: 'thread-author' },
    clock,
    postingCwd,
  )
  const reply = replyToThread(
    question.id,
    'Reply body',
    { CLAUDE_CODE_SESSION_ID: 'thread-author' },
    clock + 1,
    postingCwd,
  )
  const acknowledgement = postNotice(
    {
      audience: `session:${session}`,
      title: 'Acknowledge',
      body: 'Still needs acknowledgement',
      ackRequired: true,
    },
    {},
    clock + 2,
  )

  await boardThread(String(question.id), {
    env: { CLAUDE_CODE_SESSION_ID: session },
    clock: clock + 3,
  })
  await boardThread(String(acknowledgement.id), {
    env: { CLAUDE_CODE_SESSION_ID: session },
    clock: clock + 3,
  })
  const pending = await pendingBoardDelivery({ session, budgetMs: 0, clock: clock + 4 })

  expect(pending.delivery).toEqual([])
  expect(pending.pendingAcknowledgements.map((message) => message.id)).toEqual([
    String(acknowledgement.id),
  ])
  const stamped = db()
    .query(
      'SELECT message_id FROM board_receipt WHERE reader_session=? AND delivered_at IS NOT NULL ORDER BY message_id',
    )
    .all(session) as { message_id: number }[]
  expect(stamped.map((row) => row.message_id)).toEqual([question.id, reply.id, acknowledgement.id])
})

test('status results have one pinned shape in local and hosted modes', async () => {
  const clock = Date.parse('2026-10-05T12:00:00Z')
  const posted = await boardPost(
    { audience: 'operator', title: 'Local status', body: 'Status body' },
    { env: noRecordEnv, clock },
  )
  const local = await boardStatus(posted.id, { env: noRecordEnv, clock })
  expect(local).toEqual({
    message: {
      id: posted.id,
      kind: 'notice',
      threadRootId: null,
      title: 'Local status',
      body: 'Status body',
      audience: 'operator',
      origin: { kind: 'operator', session: null, harness: null, project: null, runId: null },
      senderTags: [],
      createdAt: '2026-10-05T12:00:00.000Z',
      expiresAt: '2026-10-06T12:00:00.000Z',
      withdrawnAt: null,
      state: 'open',
      acceptedReplyId: null,
      acceptedBy: null,
      acceptedAt: null,
      noteRecordId: null,
      noteLabel: null,
      notePendingError: null,
      revision: null,
      scopeProjectIds: null,
      recipientUserIds: null,
      claimId: null,
      authorUserId: null,
      authorSession: null,
      ackRequired: false,
      ackDeadline: null,
      text: expect.any(String),
    },
    receipts: [
      {
        messageId: posted.id,
        readerUserId: null,
        readerSession: 'operator',
        audienceAtPosting: true,
        deliveredAt: null,
        acknowledgedAt: null,
      },
    ],
    reached: 1,
    acknowledged: 0,
    unacknowledged: [],
  })

  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const message = hostedMessage()
  const receipt = {
    messageId: message.id,
    readerUserId: newRecordId(),
    readerSession: 'board-route-session',
    audienceAtPosting: true,
    deliveredAt: '2026-10-05T12:01:00.000Z',
    acknowledgedAt: null,
  }
  const hosted = await boardStatus(message.id, {
    env,
    client: {
      ...createMemoryRecordApiClient(),
      getBoardStatus: async () => ({ message, receipts: [receipt] }),
    },
  })
  const { noteId: _noteId, ...hostedMessageFields } = message
  expect(hosted).toEqual({
    message: {
      ...hostedMessageFields,
      noteRecordId: null,
      noteLabel: null,
      text: null,
    },
    receipts: [receipt],
    reached: 1,
    acknowledged: 0,
    unacknowledged: [],
  })
})

test('claim verbs stringify every id and share the same local and hosted result shape', async () => {
  const clock = Date.parse('2026-10-05T12:00:00Z')
  const local = await boardClaimTake(
    { subject: 'resource:local', project: 'board-route-project' },
    { env: noRecordEnv, clock },
  )
  expect(local.id).toMatch(/^[1-9]\d*$/)
  expect(local).toEqual({
    id: local.id,
    project: 'board-route-project',
    subject: { kind: 'resource', value: 'local' },
    holder: 'operator',
    note: null,
    runId: null,
    takenAt: '2026-10-05T12:00:00.000Z',
    renewedAt: '2026-10-05T12:00:00.000Z',
    lapsesAt: '2026-10-05T16:00:00.000Z',
    live: true,
    closedAt: null,
    closeReason: null,
    previousClaimIds: [],
    supersededByClaimId: null,
    action: 'taken',
  })
  const { action: _action, ...localView } = local
  const localRenewed = await boardClaimRenew(local.id, { env: noRecordEnv, clock: clock + 1_000 })
  expect(localRenewed).toEqual({
    ...localView,
    renewedAt: '2026-10-05T12:00:01.000Z',
    lapsesAt: '2026-10-05T16:00:01.000Z',
  })
  const localReleased = await boardClaimRelease(local.id, {
    env: noRecordEnv,
    clock: clock + 2_000,
  })
  expect(localReleased).toEqual({
    ...localRenewed,
    closedAt: '2026-10-05T12:00:02.000Z',
    closeReason: 'released',
    live: false,
  })
  await expect(
    boardClaimList('board-route-project', true, { env: noRecordEnv, clock: clock + 2_000 }),
  ).resolves.toEqual({ claims: [localReleased] })

  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const hostedClaim = {
    id: newRecordId(),
    project: 'board-route-project',
    subject: { kind: 'resource' as const, value: 'hosted' },
    holder: newRecordId(),
    note: null,
    runId: newRecordId(),
    takenAt: '2026-10-05T12:00:00.000Z',
    renewedAt: '2026-10-05T12:00:00.000Z',
    lapsesAt: '2026-10-05T12:30:00.000Z',
    live: true,
    closedAt: null,
    closeReason: null,
    previousClaimIds: [newRecordId()],
    supersededByClaimId: null,
  }
  const hostedClient = {
    ...createMemoryRecordApiClient(),
    takeBoardClaim: async () => ({ ...hostedClaim, action: 'taken' as const }),
    renewBoardClaim: async () => hostedClaim,
    releaseBoardClaim: async () => ({
      ...hostedClaim,
      live: false,
      closedAt: '2026-10-05T12:00:02.000Z',
      closeReason: 'released',
    }),
    listBoardClaims: async () => ({ claims: [hostedClaim] }),
  }
  const hostedContext = {
    env: { ORCH_RECORD_API_URL: env.ORCH_RECORD_API_URL },
    clock,
    client: hostedClient,
  }
  const hosted = await boardClaimTake(
    { subject: 'resource:hosted', project: 'board-route-project' },
    hostedContext,
  )
  expect(hosted).toEqual({ ...hostedClaim, action: 'taken' })
  await expect(boardClaimRenew(hostedClaim.id, hostedContext)).resolves.toEqual(hostedClaim)
  await expect(boardClaimRelease(hostedClaim.id, hostedContext)).resolves.toEqual({
    ...hostedClaim,
    live: false,
    closedAt: '2026-10-05T12:00:02.000Z',
    closeReason: 'released',
  })
  await expect(boardClaimList('board-route-project', true, hostedContext)).resolves.toEqual({
    claims: [hostedClaim],
  })
})

test('a local claim run id is exposed as an opaque string', async () => {
  const inserted = db()
    .query(
      `INSERT INTO run
       (started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id)
       VALUES ('2026-10-05','codex','implement','board-route-architect','sha',1,'prompt',
               'running','claim-route-session') RETURNING id`,
    )
    .get() as { id: number }
  const result = await boardClaimTake(
    { subject: 'resource:run-bound', runId: inserted.id },
    {
      env: { ...noRecordEnv, CLAUDE_CODE_SESSION_ID: 'claim-route-session' },
      cwd: process.cwd(),
      clock: Date.parse('2026-10-05T12:00:00Z'),
    },
  )
  expect(result.runId).toBe(String(inserted.id))
})

test('hosted take and list use the local claim-project actor decision', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  let called = false
  const client = {
    ...createMemoryRecordApiClient(),
    takeBoardClaim: async (): Promise<never> => {
      called = true
      throw new Error('unexpected hosted take')
    },
    listBoardClaims: async (): Promise<never> => {
      called = true
      throw new Error('unexpected hosted list')
    },
  }
  const heldProject = projectAt(process.cwd())
  if (!heldProject) throw new Error('board routing test cwd is not a registered project')
  await expect(
    boardClaimTake(
      { subject: 'resource:x', project: 'another-project' },
      { env, cwd: process.cwd(), client },
    ),
  ).rejects.toThrow(`architect session belongs to project ${heldProject.name}`)
  await expect(
    boardClaimList('another-project', false, {
      env,
      cwd: process.cwd(),
      client,
    }),
  ).rejects.toThrow(`architect session belongs to project ${heldProject.name}`)
  expect(called).toBe(false)
})

test('an adopted install routes hosted-capable message verbs only to the injected client', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const id = newRecordId()
  const calls: string[] = []
  const message = hostedMessage(id)
  const client = {
    ...createMemoryRecordApiClient(),
    postBoardMessage: async (input: { id: string }) => {
      calls.push('post')
      return { ...message, id: input.id }
    },
    replyBoardMessage: async () => {
      calls.push('reply')
      return message
    },
    withdrawBoardMessage: async () => {
      calls.push('withdraw')
      return message
    },
    getBoardThread: async () => {
      calls.push('thread')
      return { root: message, replies: [] }
    },
    getBoardStatus: async () => {
      calls.push('status')
      return { message, receipts: [] }
    },
    putBoardReceipt: async (input: {
      messageId: string
      readerSession: string
      audienceAtPosting: boolean
    }) => {
      calls.push('ack')
      return {
        messageId: input.messageId,
        readerUserId: newRecordId(),
        readerSession: input.readerSession,
        audienceAtPosting: input.audienceAtPosting,
        deliveredAt: null,
        acknowledgedAt: '2026-10-05T12:00:00.000Z',
      }
    },
  }
  await boardPost({ audience: 'operator', title: 'Hosted', body: 'body' }, { env, client })
  await boardReply(id, 'reply', { env, client })
  await boardWithdraw(id, { env, client })
  await boardThread(id, { env, client })
  await boardStatus(id, { env, client })
  await boardAcknowledge(id, { env, client })
  expect(calls).toEqual(['post', 'reply', 'withdraw', 'thread', 'status', 'ack'])
  expect(
    db().query<{ count: number }, []>('SELECT count(*) count FROM board_message').get()?.count,
  ).toBe(0)
})

test('machine audiences stay local after adoption and ids are validated for the selected mode', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const client = createMemoryRecordApiClient()
  const local = await boardPost(
    { audience: 'machine:host', title: 'Machine', body: 'local' },
    { env: { ORCH_RECORD_API_URL: env.ORCH_RECORD_API_URL }, client },
  )
  expect(local.id).toMatch(/^\d+$/)
  await expect(boardThread(local.id, { env, client })).rejects.toThrow(
    /not readable by this session/,
  )
})

test('an adopted install routes every positive-integer id only to the local service', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  let hostedCalls = 0
  const hostedUnexpected = async (): Promise<never> => {
    hostedCalls += 1
    throw new Error('hosted service was called')
  }
  const client = {
    ...createMemoryRecordApiClient(),
    replyBoardMessage: hostedUnexpected,
    withdrawBoardMessage: hostedUnexpected,
    getBoardThread: hostedUnexpected,
    getBoardStatus: hostedUnexpected,
    putBoardReceipt: hostedUnexpected,
    acceptBoardAnswer: hostedUnexpected,
    takeBoardFilingLease: hostedUnexpected,
    renewBoardClaim: hostedUnexpected,
    releaseBoardClaim: hostedUnexpected,
  }
  const localId = '999999'
  const operations: [() => Promise<unknown>, RegExp][] = [
    [() => boardReply(localId, 'reply', { env, client }), /no board message/],
    [() => boardThread(localId, { env, client }), /no board message/],
    [() => boardWithdraw(localId, { env, client }), /no board notice/],
    [() => boardAcknowledge(localId, { env, client }), /not addressed to this reader/],
    [() => boardStatus(localId, { env, client }), /no board notice/],
    [() => boardAccept(localId, localId, { env, client }), /no board message/],
    [() => boardFileNote(localId, { env, client }), /no board message/],
    [() => boardClaimRenew(localId, { env, client }), /no board claim/],
    [() => boardClaimRelease(localId, { env, client }), /no board claim/],
  ]
  for (const [operation, expected] of operations)
    await expect(operation()).rejects.toThrow(expected)
  expect(hostedCalls).toBe(0)
})

test('an adopted install routes every UUID id only to the hosted client', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  let hostedCalls = 0
  const hostedReached = async (): Promise<never> => {
    hostedCalls += 1
    throw new Error('hosted service reached')
  }
  const client = {
    ...createMemoryRecordApiClient(),
    replyBoardMessage: hostedReached,
    withdrawBoardMessage: hostedReached,
    getBoardThread: hostedReached,
    getBoardStatus: hostedReached,
    putBoardReceipt: hostedReached,
    acceptBoardAnswer: hostedReached,
    takeBoardFilingLease: hostedReached,
    renewBoardClaim: hostedReached,
    releaseBoardClaim: hostedReached,
  }
  const id = newRecordId()
  const operations = [
    () => boardReply(id, 'reply', { env, client }),
    () => boardThread(id, { env, client }),
    () => boardWithdraw(id, { env, client }),
    () => boardAcknowledge(id, { env, client }),
    () => boardStatus(id, { env, client }),
    () => boardAccept(id, id, { env, client }),
    () => boardFileNote(id, { env, client }),
    () => boardClaimRenew(id, { env, client }),
    () => boardClaimRelease(id, { env, client }),
  ]
  for (const operation of operations)
    await expect(operation()).rejects.toThrow('hosted service reached')
  expect(hostedCalls).toBe(operations.length)
})

test('an unadopted install refuses every UUID id before calling either store', async () => {
  let hostedCalls = 0
  const hostedUnexpected = async (): Promise<never> => {
    hostedCalls += 1
    throw new Error('hosted service was called')
  }
  const client = {
    ...createMemoryRecordApiClient(),
    replyBoardMessage: hostedUnexpected,
    withdrawBoardMessage: hostedUnexpected,
    getBoardThread: hostedUnexpected,
    getBoardStatus: hostedUnexpected,
    putBoardReceipt: hostedUnexpected,
    acceptBoardAnswer: hostedUnexpected,
    takeBoardFilingLease: hostedUnexpected,
    renewBoardClaim: hostedUnexpected,
    releaseBoardClaim: hostedUnexpected,
  }
  const id = newRecordId()
  const operations = [
    () => boardReply(id, 'reply', { env, client }),
    () => boardThread(id, { env, client }),
    () => boardWithdraw(id, { env, client }),
    () => boardAcknowledge(id, { env, client }),
    () => boardStatus(id, { env, client }),
    () => boardAccept(id, id, { env, client }),
    () => boardFileNote(id, { env, client }),
    () => boardClaimRenew(id, { env, client }),
    () => boardClaimRelease(id, { env, client }),
  ]
  for (const operation of operations)
    await expect(operation()).rejects.toThrow('has not adopted the hosted board')
  expect(hostedCalls).toBe(0)
})

test('hosted acknowledgement uses the reserved operator reader without a session', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const id = newRecordId()
  let readerSession: string | undefined
  const client = {
    ...createMemoryRecordApiClient(),
    putBoardReceipt: async (
      input: Parameters<ReturnType<typeof createMemoryRecordApiClient>['putBoardReceipt']>[0],
    ) => {
      readerSession = input.readerSession
      return {
        messageId: input.messageId,
        readerUserId: newRecordId(),
        readerSession: input.readerSession,
        audienceAtPosting: input.audienceAtPosting,
        deliveredAt: null,
        acknowledgedAt: '2026-10-05T12:00:00.000Z',
      }
    },
  }
  await expect(
    boardAcknowledge(id, { env: { ORCH_RECORD_API_URL: env.ORCH_RECORD_API_URL }, client }),
  ).resolves.toEqual({ acknowledged: id })
  expect(readerSession).toBe('operator')
})

test('hosted acknowledgement refuses when the service is unreachable', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const id = newRecordId()
  await expect(
    boardAcknowledge(id, {
      env: { ORCH_RECORD_API_URL: env.ORCH_RECORD_API_URL },
      client: {
        ...createMemoryRecordApiClient(),
        putBoardReceipt: async () => {
          throw new Error('record service offline')
        },
      },
    }),
  ).rejects.toThrow('record service offline')
})

test('an adopted install without hosted configuration refuses instead of writing locally', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  await expect(
    boardPost(
      { audience: 'operator', title: 'No fallback', body: 'body' },
      { env: { ...noRecordEnv, CLAUDE_CODE_SESSION_ID: 'board-route-session' } },
    ),
  ).rejects.toThrow('ORCH_RECORD_API_URL')
  expect(
    db().query<{ count: number }, []>('SELECT count(*) count FROM board_message').get()?.count,
  ).toBe(0)
})
