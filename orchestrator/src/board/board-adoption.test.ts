import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
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
const ENV = { CLAUDE_CODE_SESSION_ID: 'reader', ORCH_RECORD_API_URL: 'https://record.test' }

function presence() {
  db()
    .query(
      `INSERT INTO presence
       (session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES ('reader','claude','architect','machine',?,'/tmp',NULL,?,?)`,
    )
    .run(PLATFORM_SLUG, new Date(NOW - 1_000).toISOString(), new Date(NOW).toISOString())
}

function claim(runId: number | null = null) {
  return db()
    .query(
      `INSERT INTO board_claim
       (project,subject_kind,subject_value,holder_kind,holder_session,note,run_id,duration_ms,
        taken_at,renewed_at,lapses_at)
       VALUES (?,'task','DEV-968','architect','reader','moving',?,3600000,?,?,?)
       RETURNING id`,
    )
    .get(
      PLATFORM_SLUG,
      runId,
      new Date(NOW - 1_000).toISOString(),
      new Date(NOW - 1_000).toISOString(),
      new Date(NOW + 3_600_000).toISOString(),
    ) as { id: number }
}

function hostedMessage(
  input: Parameters<RecordApiClient['postBoardMessage']>[0],
): HostedBoardMessage {
  return {
    id: input.id,
    kind: input.kind,
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
    'the deployed record API did not serve the board routes: record API 404; deploy the record API from a commit that includes the board routes, then rerun orch board adopt',
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
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,'reader',1,?,NULL)`,
    )
    .run(notice.id, new Date(NOW - 2_000).toISOString())
  const question = askQuestion(
    { audience: 'session:reader', title: 'second', body: 'question' },
    {},
    NOW - 2_000,
  )
  replyToThread(question.id, 'reply body', {}, NOW - 1_000)
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
  expect(db().query('SELECT close_reason FROM board_claim WHERE id=?').get(localClaim.id)).toEqual({
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
    .query<{ hosted_id: string }, []>(
      "SELECT hosted_id FROM board_hosted_adoption_ledger WHERE state='pending'",
    )
    .get()!.hosted_id

  const secondCalls: string[] = []
  await adoptHostedBoard({
    confirm: 3,
    clock: () => NOW + 1,
    client: capturingClient(secondCalls).client,
  })
  expect(secondCalls.filter((call) => call.startsWith('post:'))).toEqual(['post:three'])
  expect(
    db()
      .query<{ hosted_id: string }, [string]>(
        'SELECT hosted_id FROM board_hosted_adoption_ledger WHERE local_id=(SELECT local_id FROM board_hosted_adoption_ledger WHERE hosted_id=?)',
      )
      .get(pending)?.hosted_id,
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
      `hosted service refused local ${kind} ${local.id}: hosted policy rejected this row`,
    )
    await expect(action).rejects.toThrow(
      kind === 'notice' ? `withdraw local notice ${local.id}` : `release local claim ${local.id}`,
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
    `withdraw local notice ${local.id}`,
  )
  withdrawNotice(local.id, {}, NOW + 1)

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
  replyToThread(question.id, 'blocked reply', {}, NOW + 1)
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
    `withdraw local question ${question.id}`,
  )
  withdrawNotice(question.id, {}, NOW + 3)

  const result = await adoptHostedBoard({ confirm: 0, clock: () => NOW + 4, client })

  expect(result).toMatchObject({ status: 'adopted', uploaded: 0, refused: 0, remaining: 0 })
  expect(postAttempts).toBe(1)
  expect(replyAttempts).toBe(0)
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_HOSTED_ADOPTED_KEY),
  ).toEqual({ value: '1' })
})

test('a run-tied claim without a hosted run id stays live as a lasting refusal and does not block the mark', async () => {
  const run = db()
    .query(
      `INSERT INTO run
       (started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,turn)
       VALUES (?,'codex','implement','sha',1,'prompt','running',1) RETURNING id`,
    )
    .get(new Date(NOW - 1_000).toISOString()) as { id: number }
  const localClaim = claim(run.id)
  const result = await adoptHostedBoard({
    confirm: 1,
    clock: () => NOW,
    client: capturingClient([]).client,
  })
  expect(result).toMatchObject({ status: 'adopted', refused: 1 })
  expect(db().query('SELECT closed_at FROM board_claim WHERE id=?').get(localClaim.id)).toEqual({
    closed_at: null,
  })
})

test('a lasting hosted root refusal leaves its thread local and live and still sets the mark', async () => {
  presence()
  const question = askQuestion(
    { audience: 'session:reader', title: 'refused', body: 'local remains' },
    {},
    NOW,
  )
  const reply = replyToThread(question.id, 'reply remains', {}, NOW + 1)
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
      .query('SELECT id,withdrawn_at FROM board_message WHERE id IN (?,?) ORDER BY id')
      .all(question.id, reply.id),
  ).toEqual([
    { id: question.id, withdrawn_at: null },
    { id: reply.id, withdrawn_at: null },
  ])
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_HOSTED_ADOPTED_KEY),
  ).toEqual({ value: '1' })
})

test('an absent or wrong confirmation writes no ledger, local row, claim, or adoption state', async () => {
  presence()
  const notice = postNotice({ audience: 'session:reader', title: 'one', body: 'one' }, {}, NOW)
  const localClaim = claim()
  const before = JSON.stringify({
    message: db().query('SELECT * FROM board_message WHERE id=?').get(notice.id),
    claim: db().query('SELECT * FROM board_claim WHERE id=?').get(localClaim.id),
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
      message: db().query('SELECT * FROM board_message WHERE id=?').get(notice.id),
      claim: db().query('SELECT * FROM board_claim WHERE id=?').get(localClaim.id),
    }),
  ).toBe(before)
})

test('candidate and final-mark decisions are pure', () => {
  expect(selectBoardAdoptionCandidates([])).toEqual([])
  expect(mayMarkBoardHostedAdopted(['uploaded', 'refused'])).toBeTrue()
  expect(mayMarkBoardHostedAdopted(['uploaded', 'pending'])).toBeFalse()
})

test('uses the hosted message ids returned for duplicate roots, replies, receipts, and the ledger', async () => {
  presence()
  const root = askQuestion(
    { audience: 'session:reader', title: 'duplicate', body: 'question' },
    {},
    NOW,
  )
  const reply = replyToThread(root.id, 'answer', {}, NOW + 1)
  db()
    .query(
      `INSERT OR REPLACE INTO board_receipt
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,'reader',1,?,NULL),(?,'reader',1,?,NULL)`,
    )
    .run(root.id, new Date(NOW).toISOString(), reply.id, new Date(NOW).toISOString())
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

  expect(replyRoot).toBe('stored-root')
  expect(receiptIds).toEqual(['stored-root', 'stored-reply'])
  expect(
    db()
      .query('SELECT local_id,hosted_id FROM board_hosted_adoption_ledger ORDER BY local_id')
      .all(),
  ).toEqual([
    { local_id: root.id, hosted_id: 'stored-root' },
    { local_id: reply.id, hosted_id: 'stored-reply' },
  ])
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
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,'reader',1,?,NULL)`,
    )
    .run(notice.id, new Date(NOW).toISOString())
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
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,'reader',1,?,NULL)`,
    )
    .run(notice.id, new Date(NOW).toISOString())
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
  expect(db().query('SELECT closed_at FROM board_claim WHERE id=?').get(local.id)).toEqual({
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
      .query('SELECT * FROM board_hosted_adoption_ledger WHERE local_kind=? AND local_id=?')
      .get('claim', local.id),
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
})
