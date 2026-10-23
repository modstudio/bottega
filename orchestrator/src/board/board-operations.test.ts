import { beforeEach, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { RecordApiRequestError } from '../record/record-api-client.ts'
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
  localBoardAudienceRefusal,
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
  db().query('DELETE FROM board_hosted_adoption_ledger').run()
  db().query('DELETE FROM board_message').run()
  db().query('DELETE FROM board_claim').run()
  db()
    .query(
      "INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'board-route-project','/tmp/board-route-project','{}')",
    )
    .run()
  db()
    .query(
      "INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'board-route-architect',?,'{}')",
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
  expect(result.recordId).toBeString()
  expect(result).toEqual({
    recordId: result.recordId,
    number: result.number,
    dropped: false,
    reached: 1,
    warning: null,
  })
  expect(
    db().query<{ count: number }, []>('SELECT count(*) count FROM board_message').get()?.count,
  ).toBe(1)
})

test('local board audience decision refuses shared-space reach with the hosted-board remedy', () => {
  expect(localBoardAudienceRefusal({ kind: 'spaces' })).toMatch(
    /requires the hosted board.*adopt.*--audience spaces/,
  )
  expect(localBoardAudienceRefusal({ kind: 'operator' })).toBeNull()
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
  ).resolves.toEqual({
    recordId: root.id,
    number: null,
    dropped: false,
    reached: null,
    warning: null,
  })
  await expect(boardReply(root.id, 'reply', { env, client })).resolves.toEqual({
    recordId: reply.id,
    number: null,
    rootId: root.id,
    dropped: false,
    reached: null,
    warning: null,
  })
})

test('uploaded message and claim UUIDs route to hosted rows instead of retired local shadows', async () => {
  const clock = Date.parse('2026-10-05T12:00:00Z')
  const localMessage = postNotice(
    { audience: 'operator', title: 'Adopted message', body: 'retired local shadow' },
    {},
    clock,
  )
  const localClaim = await boardClaimTake(
    { subject: 'resource:adopted', project: 'board-route-project' },
    { env: noRecordEnv, clock },
  )
  const retiredAt = new Date(clock + 1).toISOString()
  db()
    .query('UPDATE board_message SET withdrawn_at=? WHERE record_id=?')
    .run(retiredAt, localMessage.recordId)
  db()
    .query("UPDATE board_claim SET closed_at=?,close_reason='released' WHERE record_id=?")
    .run(retiredAt, localClaim.recordId)
  const ledger = db().query(
    `INSERT INTO board_hosted_adoption_ledger
     (source_record_id,local_kind,state,refusal,created_at,updated_at)
     VALUES (?,?,'uploaded',NULL,?,?)`,
  )
  ledger.run(localMessage.recordId, 'notice', retiredAt, retiredAt)
  ledger.run(localClaim.recordId, 'claim', retiredAt, retiredAt)
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')

  const hostedRow = { ...hostedMessage(localMessage.recordId), withdrawnAt: retiredAt }
  const hostedClaim = {
    id: localClaim.recordId,
    project: localClaim.project,
    subject: localClaim.subject,
    holder: localClaim.holder,
    note: 'hosted row with shared UUID',
    runId: null,
    takenAt: localClaim.takenAt,
    renewedAt: new Date(clock + 2).toISOString(),
    lapsesAt: localClaim.lapsesAt,
    live: true,
    closedAt: null,
    closeReason: null,
    previousClaimIds: [],
    supersededByClaimId: null,
  }
  const calls: string[] = []
  const client = {
    ...createMemoryRecordApiClient(),
    withdrawBoardMessage: async (id: string) => {
      calls.push(`withdraw:${id}`)
      return hostedRow
    },
    renewBoardClaim: async (id: string) => {
      calls.push(`renew:${id}`)
      return hostedClaim
    },
  }
  const adoptedContext = { env, client, clock: clock + 2 }

  await expect(boardWithdraw(localMessage.recordId, adoptedContext)).resolves.toEqual({
    withdrawn: localMessage.recordId,
  })
  await expect(boardClaimRenew(localClaim.recordId, adoptedContext)).resolves.toMatchObject({
    recordId: localClaim.recordId,
    note: 'hosted row with shared UUID',
    live: true,
  })
  expect(calls).toEqual([`withdraw:${localMessage.recordId}`, `renew:${localClaim.recordId}`])
  expect(
    db()
      .query('SELECT withdrawn_at FROM board_message WHERE record_id=?')
      .get(localMessage.recordId),
  ).toEqual({ withdrawn_at: retiredAt })
  expect(
    db().query('SELECT closed_at FROM board_claim WHERE record_id=?').get(localClaim.recordId),
  ).toEqual({ closed_at: retiredAt })
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
    .query('UPDATE board_message SET note_record_id=?,note_label=? WHERE record_id=?')
    .run('01990000-0000-7000-8000-000000000042', 'fixture#42', question.recordId)
  const local = await boardThread(question.recordId, { env: noRecordEnv, clock })
  expect(local).toEqual({
    root: {
      recordId: question.recordId,
      number: question.number,
      kind: 'question',
      purpose: 'request',
      threadRootId: null,
      title: 'Local question',
      body: 'Question body',
      audience: 'operator',
      audienceDescription: 'operator',
      origin: {
        kind: 'operator',
        session: null,
        harness: null,
        project: 'board-route-architect',
        runId: null,
      },
      senderTags: [],
      createdAt: '2026-10-05T12:00:00.000Z',
      expiresAt: '2026-10-05T16:00:00.000Z',
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
      sharedSpaceReach: null,
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
  const { noteId: _noteId, id: hostedRecordId, ...hostedRoot } = message
  expect(hosted).toEqual({
    root: {
      ...hostedRoot,
      recordId: hostedRecordId,
      number: null,
      purpose: 'information',
      noteRecordId: unresolvedNoteId,
      noteLabel: null,
      text: null,
    },
    replies: [],
  })
})

test('reading a thread stamps its printed root and replies while acknowledgement remains pending', async () => {
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'push-project',?,'{}')`,
    )
    .run(postingCwd)
  const clock = Date.parse('2026-10-08T13:00:00.000Z')
  const session = 'thread-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','push-project',(SELECT record_id FROM project WHERE name='push-project'),'/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const question = askQuestion(
    { audience: `session:${session}`, title: 'Read thread', body: 'Question body' },
    { CLAUDE_CODE_SESSION_ID: 'thread-author' },
    clock,
    postingCwd,
  )
  const reply = replyToThread(
    question.recordId,
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
      purpose: 'request',
    },
    {},
    clock + 2,
  )

  await boardThread(String(question.recordId), {
    env: { CLAUDE_CODE_SESSION_ID: session },
    clock: clock + 3,
  })
  await boardThread(String(acknowledgement.recordId), {
    env: { CLAUDE_CODE_SESSION_ID: session },
    clock: clock + 3,
  })
  const pending = await pendingBoardDelivery({ session, budgetMs: 0, clock: clock + 4 })

  expect(pending.delivery).toEqual([])
  expect(pending.pendingAcknowledgements.map((message) => message.id)).toEqual([
    String(acknowledgement.number),
  ])
  const stamped = db()
    .query(
      'SELECT message_record_id FROM board_receipt WHERE reader_session=? AND delivered_at IS NOT NULL ORDER BY message_record_id',
    )
    .all(session) as { message_record_id: string }[]
  expect(stamped.map((row) => row.message_record_id).sort()).toEqual(
    [question.recordId, reply.recordId, acknowledgement.recordId].sort(),
  )
})

test('status results have one pinned shape in local and hosted modes', async () => {
  const clock = Date.parse('2026-10-05T12:00:00Z')
  const posted = await boardPost(
    { audience: 'operator', title: 'Local status', body: 'Status body' },
    { env: noRecordEnv, clock },
  )
  const local = await boardStatus(posted.recordId, { env: noRecordEnv, clock })
  expect(local).toEqual({
    message: {
      recordId: posted.recordId,
      number: posted.number,
      kind: 'notice',
      purpose: 'information',
      threadRootId: null,
      title: 'Local status',
      body: 'Status body',
      audience: 'operator',
      audienceDescription: 'operator',
      origin: {
        kind: 'operator',
        session: null,
        harness: null,
        project: 'board-route-architect',
        runId: null,
      },
      senderTags: [],
      createdAt: '2026-10-05T12:00:00.000Z',
      expiresAt: '2026-10-05T16:00:00.000Z',
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
      sharedSpaceReach: null,
      claimId: null,
      authorUserId: null,
      authorSession: null,
      ackRequired: false,
      ackDeadline: null,
      text: expect.any(String),
    },
    receipts: [
      {
        messageId: posted.recordId,
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
  const { noteId: _noteId, id: hostedRecordId, ...hostedMessageFields } = message
  expect(hosted).toEqual({
    message: {
      ...hostedMessageFields,
      recordId: hostedRecordId,
      number: null,
      purpose: 'information',
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
  expect(local.recordId).toMatch(/^[0-9a-f-]{36}$/)
  expect(local).toEqual({
    recordId: local.recordId,
    project: 'board-route-project',
    subject: { kind: 'resource', value: 'local' },
    holder: 'operator',
    note: null,
    runId: null,
    run_record_id: null,
    takenAt: '2026-10-05T12:00:00.000Z',
    renewedAt: '2026-10-05T12:00:00.000Z',
    lapsesAt: '2026-10-05T16:00:00.000Z',
    live: true,
    closedAt: null,
    closeReason: null,
    previousClaimRecordIds: [],
    supersededByClaimRecordId: null,
    action: 'taken',
  })
  const { action: _action, ...localView } = local
  const localRenewed = await boardClaimRenew(local.recordId, {
    env: noRecordEnv,
    clock: clock + 1_000,
  })
  expect(localRenewed).toEqual({
    ...localView,
    renewedAt: '2026-10-05T12:00:01.000Z',
    lapsesAt: '2026-10-05T16:00:01.000Z',
  })
  const localReleased = await boardClaimRelease(local.recordId, {
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
  const hostedResult = {
    ...hostedClaim,
    recordId: hostedClaim.id,
    previousClaimRecordIds: hostedClaim.previousClaimIds,
    supersededByClaimRecordId: hostedClaim.supersededByClaimId,
    run_record_id: hostedClaim.runId,
  }
  delete (hostedResult as Partial<typeof hostedResult>).id
  delete (hostedResult as Partial<typeof hostedResult>).previousClaimIds
  delete (hostedResult as Partial<typeof hostedResult>).supersededByClaimId
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
  expect(hosted).toEqual({ ...hostedResult, action: 'taken' })
  await expect(boardClaimRenew(hostedClaim.id, hostedContext)).resolves.toEqual(hostedResult)
  await expect(boardClaimRelease(hostedClaim.id, hostedContext)).resolves.toEqual({
    ...hostedResult,
    live: false,
    closedAt: '2026-10-05T12:00:02.000Z',
    closeReason: 'released',
  })
  await expect(boardClaimList('board-route-project', true, hostedContext)).resolves.toEqual({
    claims: [hostedResult],
  })
})

test('a local claim run id is exposed as an opaque string', async () => {
  const inserted = db()
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id)
       VALUES ('${newRecordId()}',1,'2026-10-05','codex','implement','board-route-architect','sha',1,'prompt',
               'running','claim-route-session') RETURNING record_id AS id`,
    )
    .get() as { id: string }
  const result = await boardClaimTake(
    { subject: 'resource:run-bound', runId: inserted.id },
    {
      env: { ...noRecordEnv, CLAUDE_CODE_SESSION_ID: 'claim-route-session' },
      cwd: process.cwd(),
      clock: Date.parse('2026-10-05T12:00:00Z'),
    },
  )
  expect(result.runId).toBe(String(inserted.id))
  expect(result.run_record_id).toBe(
    (
      db().query('SELECT record_id FROM run WHERE record_id=?').get(inserted.id) as {
        record_id: string
      }
    ).record_id,
  )
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
  expect(local.recordId).toMatch(/^[0-9a-f-]{36}$/)
  await expect(boardThread(local.recordId, { env, client })).rejects.toThrow(
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
    [() => boardReply(localId, 'reply', { env, client }), /no board message has number/],
    [() => boardThread(localId, { env, client }), /no board message has number/],
    [() => boardWithdraw(localId, { env, client }), /no board message has number/],
    [() => boardAcknowledge(localId, { env, client }), /no board message has number/],
    [() => boardStatus(localId, { env, client }), /no board message has number/],
    [() => boardAccept(localId, localId, { env, client }), /no board message has number/],
    [() => boardFileNote(localId, { env, client }), /no board message has number/],
    [() => boardClaimRenew(localId, { env, client }), /invalid board claim identifier/],
    [() => boardClaimRelease(localId, { env, client }), /invalid board claim identifier/],
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
  const message = hostedMessage(id)
  db()
    .query(
      `INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload)
       VALUES (?,?,?,?,?)`,
    )
    .run(id, message.kind, message.threadRootId, message.revision, JSON.stringify(message))
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
  expect(
    db()
      .query<
        { audience_at_posting: number; acknowledged_at: string | null; pending_sync: number },
        [string, string]
      >(
        `SELECT audience_at_posting,acknowledged_at,pending_sync
         FROM hosted_board_receipt_cache WHERE message_id=? AND reader_session=?`,
      )
      .get(id, 'operator'),
  ).toEqual({
    audience_at_posting: 1,
    acknowledged_at: '2026-10-05T12:00:00.000Z',
    pending_sync: 0,
  })
})

test('hosted acknowledgement is cached and queued for unreachable and server failures', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const id = newRecordId()
  const message = hostedMessage(id)
  db()
    .query(
      `INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload)
       VALUES (?,?,?,?,?)`,
    )
    .run(id, message.kind, message.threadRootId, message.revision, JSON.stringify(message))
  for (const kind of ['unreachable', 'server'] as const) {
    await expect(
      boardAcknowledge(id, {
        clock: Date.parse('2026-10-16T12:00:00.000Z'),
        env: { ORCH_RECORD_API_URL: env.ORCH_RECORD_API_URL },
        client: {
          ...createMemoryRecordApiClient(),
          putBoardReceipt: async () => {
            throw new RecordApiRequestError('record service offline', kind, 503)
          },
        },
      }),
    ).resolves.toEqual({
      acknowledged: id,
      queued: true,
      message: 'hosted change saved and queued',
    })
  }
  expect(
    db()
      .query(
        `SELECT delivered_at,acknowledged_at,pending_sync
         FROM hosted_board_receipt_cache WHERE message_id=? AND reader_session=?`,
      )
      .get(id, 'operator'),
  ).toEqual({
    delivered_at: '2026-10-16T12:00:00.000Z',
    acknowledged_at: '2026-10-16T12:00:00.000Z',
    pending_sync: 1,
  })
})

test('hosted acknowledgement refusal is rejected without caching a pending acknowledgement', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const id = newRecordId()
  const message = hostedMessage(id)
  db()
    .query(
      `INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload)
       VALUES (?,?,?,?,?)`,
    )
    .run(id, message.kind, message.threadRootId, message.revision, JSON.stringify(message))
  await expect(
    boardAcknowledge(id, {
      env: { ORCH_RECORD_API_URL: env.ORCH_RECORD_API_URL },
      client: {
        ...createMemoryRecordApiClient(),
        putBoardReceipt: async () => {
          throw new RecordApiRequestError('acknowledgement refused', 'refused', 403)
        },
      },
    }),
  ).rejects.toThrow('acknowledgement refused')
  expect(
    db().query('SELECT count(*) count FROM hosted_board_receipt_cache WHERE message_id=?').get(id),
  ).toEqual({ count: 0 })
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
