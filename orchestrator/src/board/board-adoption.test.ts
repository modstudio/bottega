import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { type RecordApiClient, RecordApiRequestError } from '../record/record-api-client.ts'
import { CLAIM_CONFLICT } from '../record/record-board-claims.ts'
import type { HostedBoardMessage, HostedBoardReceipt } from '../record/record-board-contract.ts'
import { RATE_LIMITED } from '../record/record-board-messages.ts'
import { adoptHostedBoard } from './board-adoption.ts'
import {
  mayMarkBoardHostedAdopted,
  selectBoardAdoptionCandidates,
  uploadErrorDisposition,
} from './board-adoption-policy.ts'
import { claimBoardNotices } from './board-delivery.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import { postNotice, withdrawNotice } from './board-service.ts'
import { askQuestion, replyToThread } from './board-thread-service.ts'

const NOW = Date.parse('2026-10-05T12:00:00.000Z')
const ENV = { CLAUDE_CODE_SESSION_ID: 'reader', BOTTEGA_RECORD_API_URL: 'https://record.test' }

function presence(session = 'reader', lastSeen = NOW) {
  db()
    .query(
      `INSERT INTO presence
       (session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude','architect','machine',?,(SELECT record_id FROM project WHERE name=?),'/tmp',NULL,?,?)`,
    )
    .run(
      session,
      PLATFORM_SLUG,
      PLATFORM_SLUG,
      new Date(lastSeen - 1_000).toISOString(),
      new Date(lastSeen).toISOString(),
    )
}

function receipt(messageRecordId: string, reader: string) {
  db()
    .query(
      `INSERT OR REPLACE INTO board_receipt
       (record_id,message_record_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,?,?,1,?,NULL)`,
    )
    .run(newRecordId(), messageRecordId, reader, new Date(NOW).toISOString())
}

function claim(runId: string | null = null) {
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,canon,settings)
       VALUES (?,?,'/tmp/${PLATFORM_SLUG}',1,'{}')`,
    )
    .run('01990000-0000-7000-8000-000000000088', PLATFORM_SLUG)
  return db()
    .query(
      `INSERT INTO board_claim
       (record_id,project,subject_kind,subject_value,holder_kind,holder_session,note,run_record_id,duration_ms,
        taken_at,renewed_at,lapses_at)
       VALUES (?,?,'task','DEV-968','architect','reader','moving',?,3600000,?,?,?)
       RETURNING record_id AS recordId`,
    )
    .get(
      newRecordId(),
      PLATFORM_SLUG,
      runId,
      new Date(NOW - 1_000).toISOString(),
      new Date(NOW - 1_000).toISOString(),
      new Date(NOW + 3_600_000).toISOString(),
    ) as { recordId: string }
}

function hostedMessage(
  input: Parameters<RecordApiClient['postBoardMessage']>[0],
): HostedBoardMessage {
  return {
    id: input.id,
    kind: input.kind,
    purpose: input.purpose ?? 'information',
    threadRootId: null,
    title: input.title,
    body: input.body,
    audience: input.audience,
    origin: {
      kind: 'architect',
      session: input.authorSession ?? null,
      harness: input.authorHarness ?? null,
      project: input.project ?? null,
      runId: input.authorRunId ?? null,
    },
    senderTags: [],
    createdAt: new Date(NOW).toISOString(),
    expiresAt: input.expiresAt,
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
    authorUserId: '01990000-0000-7000-8000-000000000001',
    authorSession: input.authorSession ?? null,
    ackRequired: input.ackRequired ?? false,
    ackDeadline: input.ackDeadline ?? null,
  }
}

test('a new adoption upload sends the row record id as the hosted id', async () => {
  presence()
  const posted = postNotice(
    { audience: 'session:reader', title: 'identity', body: 'identity' },
    {},
    NOW,
  )
  const recordId = posted.recordId
  const ids: string[] = []
  const base = capturingClient([]).client
  const client: RecordApiClient = {
    ...base,
    async postBoardMessage(input) {
      ids.push(input.id)
      return hostedMessage(input)
    },
  }
  await adoptHostedBoard({ confirm: 1, clock: () => NOW, client })
  expect(ids).toEqual([recordId])
  expect(
    db()
      .query<{ source_record_id: string }, []>(
        'SELECT source_record_id FROM board_hosted_adoption_ledger',
      )
      .get(),
  ).toEqual({ source_record_id: recordId })
})

test('an adoption resume uploads with the row record id', async () => {
  presence()
  const posted = postNotice(
    { audience: 'session:reader', title: 'resume identity', body: 'resume' },
    {},
    NOW,
  )
  const recordId = posted.recordId
  db()
    .query(
      `INSERT INTO board_hosted_adoption_ledger
       (source_record_id,local_kind,state,refusal,created_at,updated_at)
       VALUES (?,'notice','pending',NULL,?,?)`,
    )
    .run(recordId, new Date(NOW).toISOString(), new Date(NOW).toISOString())
  const ids: string[] = []
  const base = capturingClient([]).client
  const client: RecordApiClient = {
    ...base,
    async postBoardMessage(input) {
      ids.push(input.id)
      return hostedMessage(input)
    },
  }
  await adoptHostedBoard({ confirm: 1, clock: () => NOW + 1, client })
  expect(ids).toEqual([recordId])
})

test('adoption uploads a reply local project name and hosted record id', async () => {
  presence()
  const root = askQuestion(
    { audience: 'session:reader', title: 'reply identity', body: 'question' },
    {},
    NOW,
  )
  const reply = replyToThread(root.recordId, 'reply identity body', {}, NOW + 1, undefined, {
    kind: 'acknowledged',
  })
  const project = { name: 'adoption-reply-project' }
  const projectId = newRecordId()
  db()
    .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(projectId, project.name, '/tmp/adoption-reply-project', '{}')
  db()
    .query('UPDATE board_message SET author_project=? WHERE record_id=?')
    .run(project.name, reply.recordId)
  let uploaded: Parameters<RecordApiClient['replyBoardMessage']>[1] | undefined
  const base = capturingClient([]).client
  const client: RecordApiClient = {
    ...base,
    async replyBoardMessage(rootId, input) {
      uploaded = input
      return base.replyBoardMessage(rootId, input)
    },
  }

  await adoptHostedBoard({ confirm: 2, clock: () => NOW + 2, client })

  expect(uploaded).toMatchObject({
    project: project.name,
    projectId,
    audience: { kind: 'acknowledged' },
  })
})

test('adoption preserves request and acknowledgement-required standing purposes', async () => {
  const request = postNotice(
    { audience: 'operator', title: 'Request to adopt', body: 'Request body', purpose: 'request' },
    {},
    NOW - 2_000,
  )
  const standing = postNotice(
    {
      audience: 'operator',
      title: 'Standing to adopt',
      body: 'Standing body',
      purpose: 'standing',
      ackRequired: true,
    },
    {},
    NOW - 1_000,
  )
  const inputs: Parameters<RecordApiClient['postBoardMessage']>[0][] = []
  const base = createMemoryRecordApiClient()
  const client: RecordApiClient = {
    ...base,
    async listBoardChanges() {
      return { userId: '01990000-0000-7000-8000-000000000001', items: [], highestRevision: null }
    },
    async postBoardMessage(input) {
      inputs.push(input)
      return hostedMessage(input)
    },
  }

  const result = await adoptHostedBoard({ confirm: 2, clock: () => NOW, client })

  expect(result.status).toBe('adopted')
  expect(
    inputs.map(({ title, purpose, ackRequired }) => ({ title, purpose, ackRequired })),
  ).toEqual([
    { title: 'Request to adopt', purpose: 'request', ackRequired: false },
    { title: 'Standing to adopt', purpose: 'standing', ackRequired: true },
  ])
  expect(
    db().query('SELECT withdrawn_at FROM board_message WHERE record_id=?').get(request.recordId),
  ).not.toEqual({
    withdrawn_at: null,
  })
  expect(
    db().query('SELECT withdrawn_at FROM board_message WHERE record_id=?').get(standing.recordId),
  ).not.toEqual({
    withdrawn_at: null,
  })
})

function capturingClient(calls: string[], failTitle?: string) {
  const base = createMemoryRecordApiClient()
  const messages = new Map<string, HostedBoardMessage>()
  const receipts: HostedBoardReceipt[] = []
  const client: RecordApiClient = {
    ...base,
    async listBoardChanges() {
      calls.push('changes')
      return {
        userId: '01990000-0000-7000-8000-000000000001',
        items: [...messages.values()].map((message) => ({
          message,
          tags: [],
          receipts: receipts.filter((receipt) => receipt.messageId === message.id),
        })),
        highestRevision: messages.size ? '1' : null,
      }
    },
    async postBoardMessage(input) {
      calls.push(`post:${input.title}`)
      if (input.title === failTitle)
        throw new RecordApiRequestError(
          'board post rate limit reached; retry after the ten-minute author window',
          'refused',
        )
      const message = hostedMessage(input)
      messages.set(input.id, message)
      return message
    },
    async replyBoardMessage(rootId, input) {
      calls.push('reply')
      const root = messages.get(rootId)!
      const message = {
        ...root,
        id: input.id,
        kind: 'reply',
        threadRootId: rootId,
        body: input.body,
      }
      messages.set(input.id, message)
      return message
    },
    async putBoardReceipt(input) {
      calls.push('receipt')
      const receipt = {
        messageId: input.messageId,
        readerUserId: '01990000-0000-7000-8000-000000000001',
        readerSession: input.readerSession,
        audienceAtPosting: input.audienceAtPosting,
        deliveredAt: input.delivered ? new Date(NOW).toISOString() : null,
        acknowledgedAt: input.acknowledged ? new Date(NOW).toISOString() : null,
      }
      receipts.push(receipt)
      return receipt
    },
    async takeBoardClaim(input) {
      calls.push('claim')
      return {
        id: input.id,
        project: input.project,
        subject: { kind: 'task', value: 'DEV-968' },
        holder: input.holderSession ?? 'operator',
        note: input.note ?? null,
        runId: input.runId ?? null,
        takenAt: new Date(NOW).toISOString(),
        renewedAt: new Date(NOW).toISOString(),
        lapsesAt: new Date(NOW + (input.durationMs ?? 1)).toISOString(),
        live: true,
        closedAt: null,
        closeReason: null,
        previousClaimIds: [],
        supersededByClaimId: null,
        action: 'taken',
      }
    },
  }
  return { client, messages }
}

test('a refused board probe names the missing routes and writes no adoption state', async () => {
  const base = createMemoryRecordApiClient()
  const refusal = new RecordApiRequestError('record API 404', 'refused')
  const client: RecordApiClient = {
    ...base,
    async listBoardChanges() {
      throw refusal
    },
  }

  const action = adoptHostedBoard({ client })

  await expect(action).rejects.toThrow(
    `the deployed record API did not serve the board routes: record API 404; deploy the record API from a commit that includes the board routes, then rerun ${PLATFORM_SLUG} board adopt`,
  )
  expect(db().query('SELECT count(*) count FROM board_hosted_adoption_ledger').get()).toEqual({
    count: 0,
  })
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_HOSTED_ADOPTED_KEY),
  ).toBeNull()
})

test('confirmed adoption uploads roots before replies, then receipts and claims, retires local rows, and suppresses both copies', async () => {
  presence()
  const notice = postNotice(
    { audience: 'session:reader', title: 'first', body: 'notice' },
    {},
    NOW - 3_000,
  )
  db()
    .query(
      `INSERT OR REPLACE INTO board_receipt
       (record_id,message_record_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,?,'reader',1,?,NULL)`,
    )
    .run(newRecordId(), notice.recordId, new Date(NOW - 2_000).toISOString())
  const question = askQuestion(
    { audience: 'session:reader', title: 'second', body: 'question' },
    {},
    NOW - 2_000,
  )
  replyToThread(question.recordId, 'reply body', {}, NOW - 1_000)
  const localClaim = claim()
  const calls: string[] = []
  const { client } = capturingClient(calls)
  installRecordApiClient(client)

  const result = await adoptHostedBoard({ confirm: 4, clock: () => NOW, client })

  expect(result.status).toBe('adopted')
  expect(calls.filter((call) => call !== 'changes')).toEqual([
    'post:first',
    'post:second',
    'reply',
    'receipt',
    'claim',
  ])
  expect(
    db()
      .query<{ count: number }, []>(
        'SELECT count(*) count FROM board_message WHERE withdrawn_at IS NOT NULL',
      )
      .get()?.count,
  ).toBe(3)
  expect(
    db().query('SELECT close_reason FROM board_claim WHERE record_id=?').get(localClaim.recordId),
  ).toEqual({
    close_reason: 'released',
  })
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_HOSTED_ADOPTED_KEY),
  ).toEqual({ value: '1' })
  expect((await claimBoardNotices(false, { env: ENV })).notices).toEqual([])
})

test('rate cap leaves the mark unset and reruns only the remainder with its stable hosted id', async () => {
  presence()
  postNotice({ audience: 'session:reader', title: 'one', body: 'one' }, {}, NOW - 2)
  postNotice({ audience: 'session:reader', title: 'two', body: 'two' }, {}, NOW - 1)
  postNotice({ audience: 'session:reader', title: 'three', body: 'three' }, {}, NOW)
  const firstCalls: string[] = []
  const rateClient = capturingClient(firstCalls, 'three').client
  const firstClient: RecordApiClient = {
    ...rateClient,
    async postBoardMessage(input) {
      if (input.title === 'one') {
        firstCalls.push('post:one')
        throw new RecordApiRequestError(
          `unknown or invisible board project ${PLATFORM_SLUG}`,
          'refused',
        )
      }
      return rateClient.postBoardMessage(input)
    },
  }
  const stopped = await adoptHostedBoard({
    confirm: 3,
    clock: () => NOW,
    client: firstClient,
  })
  expect(stopped).toMatchObject({ status: 'stopped', uploaded: 1, refused: 1, remaining: 1 })
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_HOSTED_ADOPTED_KEY),
  ).toBeNull()
  const pending = db()
    .query<{ source_record_id: string }, []>(
      "SELECT source_record_id FROM board_hosted_adoption_ledger WHERE state='pending'",
    )
    .get()!.source_record_id

  const secondCalls: string[] = []
  await adoptHostedBoard({
    confirm: 3,
    clock: () => NOW + 1,
    client: capturingClient(secondCalls).client,
  })
  expect(secondCalls.filter((call) => call.startsWith('post:'))).toEqual(['post:three'])
  expect(
    db()
      .query<{ source_record_id: string }, [string]>(
        'SELECT source_record_id FROM board_hosted_adoption_ledger WHERE source_record_id=?',
      )
      .get(pending)?.source_record_id,
  ).toBe(pending)
})

test.each(['notice', 'claim'] as const)(
  'an unexpected hosted refusal names the local %s row and its adoption remedy',
  async (kind) => {
    presence()
    const local =
      kind === 'notice'
        ? postNotice({ audience: 'session:reader', title: 'one', body: 'one' }, {}, NOW)
        : claim()
    const base = capturingClient([]).client
    const refuse = () => {
      throw new RecordApiRequestError('hosted policy rejected this row', 'refused')
    }
    const client: RecordApiClient = {
      ...base,
      ...(kind === 'notice' ? { postBoardMessage: refuse } : { takeBoardClaim: refuse }),
    }
    const action = adoptHostedBoard({ confirm: 1, clock: () => NOW, client })
    await expect(action).rejects.toThrow(
      `hosted service refused local ${kind} ${local.recordId}: hosted policy rejected this row`,
    )
    await expect(action).rejects.toThrow(
      kind === 'notice'
        ? `withdraw local notice ${local.recordId}`
        : `release local claim ${local.recordId}`,
    )
    expect(
      db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_HOSTED_ADOPTED_KEY),
    ).toBeNull()
  },
)

test('withdrawing a row after an unexpected refusal drops its pending ledger row from the rerun', async () => {
  presence()
  const local = postNotice(
    { audience: 'session:reader', title: 'blocked', body: 'blocked' },
    {},
    NOW,
  )
  let postAttempts = 0
  const base = capturingClient([]).client
  const client: RecordApiClient = {
    ...base,
    async postBoardMessage() {
      postAttempts++
      throw new RecordApiRequestError('hosted policy rejected this row', 'refused')
    },
  }

  await expect(adoptHostedBoard({ confirm: 1, clock: () => NOW, client })).rejects.toThrow(
    `withdraw local notice ${local.recordId}`,
  )
  withdrawNotice(local.recordId, {}, NOW + 1)

  const result = await adoptHostedBoard({ confirm: 0, clock: () => NOW + 2, client })

  expect(result).toMatchObject({ status: 'adopted', uploaded: 0, refused: 0, remaining: 0 })
  expect(postAttempts).toBe(1)
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_HOSTED_ADOPTED_KEY),
  ).toEqual({ value: '1' })
})

test('withdrawing a pending root drops its reply from the rerun', async () => {
  presence()
  const question = askQuestion(
    { audience: 'session:reader', title: 'blocked thread', body: 'blocked question' },
    {},
    NOW,
  )
  replyToThread(question.recordId, 'blocked reply', {}, NOW + 1)
  let postAttempts = 0
  let replyAttempts = 0
  const base = capturingClient([]).client
  const client: RecordApiClient = {
    ...base,
    async postBoardMessage() {
      postAttempts++
      throw new RecordApiRequestError('hosted policy rejected this row', 'refused')
    },
    async replyBoardMessage(rootId, input) {
      replyAttempts++
      return base.replyBoardMessage(rootId, input)
    },
  }

  await expect(adoptHostedBoard({ confirm: 2, clock: () => NOW + 2, client })).rejects.toThrow(
    `withdraw local question ${question.recordId}`,
  )
  withdrawNotice(question.recordId, {}, NOW + 3)

  const result = await adoptHostedBoard({ confirm: 0, clock: () => NOW + 4, client })

  expect(result).toMatchObject({ status: 'adopted', uploaded: 0, refused: 0, remaining: 0 })
  expect(postAttempts).toBe(1)
  expect(replyAttempts).toBe(0)
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_HOSTED_ADOPTED_KEY),
  ).toEqual({ value: '1' })
})

test('a lasting hosted root refusal leaves its thread local and live and still sets the mark', async () => {
  presence()
  const question = askQuestion(
    { audience: 'session:reader', title: 'refused', body: 'local remains' },
    {},
    NOW,
  )
  const reply = replyToThread(question.recordId, 'reply remains', {}, NOW + 1)
  const base = capturingClient([]).client
  const client: RecordApiClient = {
    ...base,
    async postBoardMessage() {
      throw new RecordApiRequestError(
        `unknown or invisible board project ${PLATFORM_SLUG}`,
        'refused',
      )
    },
  }
  const result = await adoptHostedBoard({ confirm: 2, clock: () => NOW + 2, client })
  expect(result).toMatchObject({ status: 'adopted', refused: 2 })
  expect(
    db()
      .query(
        'SELECT record_id,withdrawn_at FROM board_message WHERE record_id IN (?,?) ORDER BY record_id',
      )
      .all(question.recordId, reply.recordId),
  ).toEqual(
    [
      { record_id: question.recordId, withdrawn_at: null },
      { record_id: reply.recordId, withdrawn_at: null },
    ].sort((left, right) => left.record_id.localeCompare(right.record_id)),
  )
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_HOSTED_ADOPTED_KEY),
  ).toEqual({ value: '1' })
})

test('an absent or wrong confirmation writes no ledger, local row, claim, or adoption state', async () => {
  presence()
  const notice = postNotice({ audience: 'session:reader', title: 'one', body: 'one' }, {}, NOW)
  const localClaim = claim()
  const before = JSON.stringify({
    message: db().query('SELECT * FROM board_message WHERE record_id=?').get(notice.recordId),
    claim: db().query('SELECT * FROM board_claim WHERE record_id=?').get(localClaim.recordId),
  })
  const client = capturingClient([]).client
  expect((await adoptHostedBoard({ clock: () => NOW, client })).status).toBe('plan')
  await expect(adoptHostedBoard({ confirm: 1, clock: () => NOW, client })).rejects.toThrow(
    'current candidate total 2',
  )
  expect(db().query('SELECT count(*) count FROM board_hosted_adoption_ledger').get()).toEqual({
    count: 0,
  })
  expect(
    JSON.stringify({
      message: db().query('SELECT * FROM board_message WHERE record_id=?').get(notice.recordId),
      claim: db().query('SELECT * FROM board_claim WHERE record_id=?').get(localClaim.recordId),
    }),
  ).toBe(before)
})

test('candidate and final-mark decisions are pure', () => {
  expect(selectBoardAdoptionCandidates([])).toEqual([])
  expect(mayMarkBoardHostedAdopted(['uploaded', 'refused'])).toBeTrue()
  expect(mayMarkBoardHostedAdopted(['uploaded', 'pending'])).toBeFalse()
})

test('keeps source record ids for roots, replies, receipts, and the ledger', async () => {
  presence()
  const root = askQuestion(
    { audience: 'session:reader', title: 'duplicate', body: 'question' },
    {},
    NOW,
  )
  const reply = replyToThread(root.recordId, 'answer', {}, NOW + 1)
  db()
    .query(
      `INSERT OR REPLACE INTO board_receipt
       (record_id,message_record_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,?,'reader',1,?,NULL),(?,?,'reader',1,?,NULL)`,
    )
    .run(
      newRecordId(),
      root.recordId,
      new Date(NOW).toISOString(),
      newRecordId(),
      reply.recordId,
      new Date(NOW).toISOString(),
    )
  const base = capturingClient([]).client
  const receiptIds: string[] = []
  let replyRoot = ''
  const client: RecordApiClient = {
    ...base,
    async postBoardMessage(input) {
      return { ...hostedMessage(input), id: 'stored-root' }
    },
    async replyBoardMessage(rootId, input) {
      replyRoot = rootId
      return {
        ...hostedMessage({
          id: input.id,
          kind: 'notice',
          audience: 'session:reader',
          title: 'reply',
          body: input.body,
          expiresAt: new Date(NOW + 10_000).toISOString(),
        }),
        id: 'stored-reply',
        kind: 'reply',
        threadRootId: rootId,
      }
    },
    async putBoardReceipt(input) {
      receiptIds.push(input.messageId)
      return base.putBoardReceipt(input)
    },
  }

  await adoptHostedBoard({ confirm: 2, clock: () => NOW + 2, client })

  const rootRecordId = root.recordId
  const replyRecordId = reply.recordId
  expect(replyRoot).toBe(rootRecordId)
  expect(receiptIds).toEqual([rootRecordId, replyRecordId])
  expect(
    db()
      .query('SELECT source_record_id FROM board_hosted_adoption_ledger ORDER BY source_record_id')
      .all(),
  ).toEqual(
    [{ source_record_id: rootRecordId }, { source_record_id: replyRecordId }].sort((a, b) =>
      a.source_record_id.localeCompare(b.source_record_id),
    ),
  )
})

test('counts refused receipts without blocking adoption', async () => {
  presence()
  const notice = postNotice(
    { audience: 'session:reader', title: 'receipt', body: 'receipt' },
    {},
    NOW,
  )
  db()
    .query(
      `INSERT OR REPLACE INTO board_receipt
       (record_id,message_record_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,?,'reader',1,?,NULL)`,
    )
    .run(newRecordId(), notice.recordId, new Date(NOW).toISOString())
  const base = capturingClient([]).client
  const refusedClient: RecordApiClient = {
    ...base,
    async putBoardReceipt() {
      throw new RecordApiRequestError('receipt is no longer visible', 'refused')
    },
  }
  const result = await adoptHostedBoard({ confirm: 1, clock: () => NOW, client: refusedClient })
  expect(result).toMatchObject({ status: 'adopted', skippedReceipts: 1 })
})

test('a receipt network failure stops adoption with its mark unset', async () => {
  presence()
  const notice = postNotice(
    { audience: 'session:reader', title: 'receipt network', body: 'receipt' },
    {},
    NOW,
  )
  db()
    .query(
      `INSERT OR REPLACE INTO board_receipt
       (record_id,message_record_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,?,'reader',1,?,NULL)`,
    )
    .run(newRecordId(), notice.recordId, new Date(NOW).toISOString())
  const base = capturingClient([]).client
  const client: RecordApiClient = {
    ...base,
    async putBoardReceipt() {
      throw new RecordApiRequestError('receipt network offline', 'unreachable')
    },
  }

  await expect(adoptHostedBoard({ confirm: 1, clock: () => NOW, client })).rejects.toThrow(
    'receipt network offline',
  )
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_HOSTED_ADOPTED_KEY),
  ).toBeNull()
})

test('the plan and upload include only receipts for readers that are still around', async () => {
  presence('live-reader')
  const projectRecordId = newRecordId()
  upsertProject({ recordId: projectRecordId, name: 'board-adoption-run', path: '/tmp/board-run' })
  const finishedRun = db()
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,turn,project_record_id)
       VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','sha',1,'prompt','ok',1,?)
       RETURNING record_id AS id`,
    )
    .get(new Date(NOW - 1_000).toISOString(), projectRecordId) as { id: string }
  const notice = postNotice(
    { audience: 'session:live-reader', title: 'reader liveness', body: 'receipt' },
    {},
    NOW,
  )
  receipt(notice.recordId, 'live-reader')
  receipt(notice.recordId, 'long-gone-reader')
  receipt(notice.recordId, `run:${finishedRun.id}`)
  const readers: string[] = []
  const base = capturingClient([]).client
  const client: RecordApiClient = {
    ...base,
    async putBoardReceipt(input) {
      readers.push(input.readerSession)
      return base.putBoardReceipt(input)
    },
  }

  const plan = await adoptHostedBoard({ clock: () => NOW, client })
  expect(plan).toMatchObject({ status: 'plan', total: 1, receipts: 1 })
  expect(plan.note).toContain('Hosted reach counts readers from adoption onward.')
  await adoptHostedBoard({ confirm: 1, clock: () => NOW, client })

  expect(readers).toEqual(['live-reader'])
})

test('a receipt server failure resumes after recorded successes and sends only the remainder', async () => {
  for (const reader of ['resume-a', 'resume-b', 'resume-c']) presence(reader)
  const notice = postNotice(
    { audience: 'session:resume-a', title: 'resumable receipts', body: 'receipt' },
    {},
    NOW,
  )
  for (const reader of ['resume-a', 'resume-b', 'resume-c']) receipt(notice.recordId, reader)
  const firstRequests: string[] = []
  const base = capturingClient([]).client
  const failingClient: RecordApiClient = {
    ...base,
    async putBoardReceipt(input) {
      firstRequests.push(input.readerSession)
      if (input.readerSession === 'resume-b')
        throw new RecordApiRequestError('record API 500', 'server', 500)
      return base.putBoardReceipt(input)
    },
  }

  await expect(
    adoptHostedBoard({ confirm: 1, clock: () => NOW, client: failingClient }),
  ).rejects.toThrow('record API 500')
  expect(firstRequests).toEqual(['resume-a', 'resume-b'])
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_HOSTED_ADOPTED_KEY),
  ).toBeNull()

  const resumedRequests: string[] = []
  const resumedClient: RecordApiClient = {
    ...base,
    async putBoardReceipt(input) {
      resumedRequests.push(input.readerSession)
      return base.putBoardReceipt(input)
    },
  }
  const result = await adoptHostedBoard({ confirm: 1, clock: () => NOW + 1, client: resumedClient })

  expect(resumedRequests).toEqual(['resume-b', 'resume-c'])
  expect(result.status).toBe('adopted')
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_HOSTED_ADOPTED_KEY),
  ).toEqual({ value: '1' })
})

test('an install with uploaded message ledger rows and no receipt ledger completes with the same confirmation', async () => {
  presence('stuck-reader')
  for (let index = 0; index < 6; index++) {
    const notice = postNotice(
      {
        audience: 'session:stuck-reader',
        title: `stuck ${index}`,
        body: 'receipt',
      },
      {},
      NOW + index,
    )
    const hostedId = notice.recordId
    db()
      .query(
        `INSERT INTO board_hosted_adoption_ledger
         (source_record_id,local_kind,state,refusal,created_at,updated_at)
         VALUES (?,'notice','uploaded',NULL,?,?)`,
      )
      .run(hostedId, new Date(NOW).toISOString(), new Date(NOW).toISOString())
    db()
      .query('UPDATE board_message SET withdrawn_at=? WHERE record_id=?')
      .run(new Date(NOW + 10).toISOString(), notice.recordId)
    receipt(notice.recordId, 'stuck-reader')
  }
  const calls: string[] = []
  const client = capturingClient(calls).client

  const result = await adoptHostedBoard({ confirm: 6, clock: () => NOW + 20, client })

  expect(result.status).toBe('adopted')
  expect(calls.filter((call) => call.startsWith('post:'))).toEqual([])
  expect(calls.filter((call) => call === 'receipt')).toHaveLength(6)
  expect(db().query('SELECT count(*) count FROM board_hosted_adoption_receipt').get()).toEqual({
    count: 6,
  })
})

test('a refused receipt is recorded as skipped and is not sent again on a rerun', async () => {
  presence('refused-a')
  presence('refused-b')
  const notice = postNotice(
    { audience: 'session:refused-a', title: 'refused receipt', body: 'receipt' },
    {},
    NOW,
  )
  receipt(notice.recordId, 'refused-a')
  receipt(notice.recordId, 'refused-b')
  const firstRequests: string[] = []
  const base = capturingClient([]).client
  const firstClient: RecordApiClient = {
    ...base,
    async putBoardReceipt(input) {
      firstRequests.push(input.readerSession)
      if (input.readerSession === 'refused-a')
        throw new RecordApiRequestError('receipt is no longer visible', 'refused')
      throw new RecordApiRequestError('record API 500', 'server', 500)
    },
  }

  await expect(
    adoptHostedBoard({ confirm: 1, clock: () => NOW, client: firstClient }),
  ).rejects.toThrow('record API 500')
  expect(firstRequests).toEqual(['refused-a', 'refused-b'])
  expect(
    db()
      .query(
        `SELECT state,refusal FROM board_hosted_adoption_receipt
         WHERE message_record_id=? AND reader_session=?`,
      )
      .get(notice.recordId, 'refused-a'),
  ).toEqual({ state: 'skipped', refusal: 'receipt is no longer visible' })

  const resumedRequests: string[] = []
  const resumedClient: RecordApiClient = {
    ...base,
    async putBoardReceipt(input) {
      resumedRequests.push(input.readerSession)
      return base.putBoardReceipt(input)
    },
  }
  const result = await adoptHostedBoard({ confirm: 1, clock: () => NOW + 1, client: resumedClient })

  expect(resumedRequests).toEqual(['refused-b'])
  expect(result).toMatchObject({ status: 'adopted', skippedReceipts: 0 })
})

test('records a hosted claim conflict as a lasting refusal and still adopts', async () => {
  const local = claim()
  const base = capturingClient([]).client
  const client: RecordApiClient = {
    ...base,
    async takeBoardClaim() {
      throw new RecordApiRequestError(`${CLAIM_CONFLICT} user other until tomorrow`, 'refused')
    },
  }

  const result = await adoptHostedBoard({ confirm: 1, clock: () => NOW, client })

  expect(result).toMatchObject({ status: 'adopted', refused: 1 })
  expect(
    db().query('SELECT closed_at FROM board_claim WHERE record_id=?').get(local.recordId),
  ).toEqual({
    closed_at: null,
  })
})

test('drops a claim that expires before its request and clears its pending ledger', async () => {
  const local = claim()
  let now = NOW
  let claimWrites = 0
  const base = capturingClient([]).client
  const client: RecordApiClient = {
    ...base,
    async takeBoardClaim(input) {
      claimWrites++
      return base.takeBoardClaim(input)
    },
  }
  const clock = () => {
    const value = now
    now = NOW + 3_600_001
    return value
  }

  const result = await adoptHostedBoard({ confirm: 1, clock, client })

  expect(result).toMatchObject({ status: 'adopted', uploaded: 0, remaining: 0 })
  expect(claimWrites).toBe(0)
  expect(
    db()
      .query(
        `SELECT * FROM board_hosted_adoption_ledger
         WHERE source_record_id=?`,
      )
      .get(local.recordId),
  ).toBeNull()
})

test('upload error disposition covers every hosted adoption classification', () => {
  expect(uploadErrorDisposition('refused', RATE_LIMITED)).toBe('rate')
  expect(
    uploadErrorDisposition(
      'refused',
      'board authorMachineId is missing, invisible, or not owned by this user',
    ),
  ).toBe('machine')
  for (const message of [
    'unknown or invisible board project example',
    'row-level security rejected the row',
    'run was not started by this user',
    `${CLAIM_CONFLICT} user other until tomorrow`,
  ])
    expect(uploadErrorDisposition('refused', message)).toBe('lasting')
  expect(uploadErrorDisposition('refused', 'some other policy')).toBe('unexpected')
  expect(uploadErrorDisposition('unreachable', `${CLAIM_CONFLICT} user other`)).toBe('unexpected')
  expect(uploadErrorDisposition('server', `${CLAIM_CONFLICT} user other`)).toBe('unexpected')
})
