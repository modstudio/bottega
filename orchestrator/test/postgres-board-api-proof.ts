import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import {
  claimCachedHosted,
  markCachedHostedDelivered,
  refreshHostedBoard,
} from '../src/board/board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from '../src/board/board-mode.ts'
import { BOARD_POST_RATE_LIMIT } from '../src/board/board-policy.ts'
import { applyMigrations } from '../src/database/migrations.ts'
import type { RecordApiClient } from '../src/record/record-api-client.ts'
import { startRecordApiServer } from '../src/record/record-api-server.ts'
import { recordAuth } from '../src/record/record-auth.ts'
import { SIGN_UP_AUTH } from './fixtures/record-auth-postgres.ts'
import { registerBoardAdoptionProof } from './postgres-board-adoption-proof.ts'
import { postgresBoardCacheClient } from './postgres-board-cache-client.ts'

type Succeeds = (user: string, password: string, source: string) => string

const IDS = {
  inviteA: '03990000-0000-7000-8000-000000000001',
  inviteB: '03990000-0000-7000-8000-000000000002',
  inviteC: '03990000-0000-7000-8000-000000000003',
  inviteD: '03990000-0000-7000-8000-000000000004',
  project: '03990000-0000-7000-8000-000000000011',
  projectTwo: '03990000-0000-7000-8000-000000000012',
  memberB: '03990000-0000-7000-8000-000000000021',
  memberA2: '03990000-0000-7000-8000-000000000022',
  memberRead: '03990000-0000-7000-8000-000000000023',
} as const

const EMAIL = {
  a: 'board-api-a@example.test',
  b: 'board-api-b@example.test',
  c: 'board-api-c@example.test',
  d: 'board-api-d@example.test',
} as const

const PROJECT = 'board-api-shared'
const PROJECT_TWO = 'board-api-second'
const expiresAt = '2099-01-01T00:00:00.000Z'

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

export function registerBoardApiProofs(input: {
  actorUrl: string
  spaceA: string
  userA: string
  succeeds: Succeeds
}): void {
  let origin = ''
  let server: ReturnType<typeof startRecordApiServer> | undefined
  let tokenA = ''
  let tokenB = ''
  let tokenC = ''
  let tokenD = ''
  let userA = ''
  let userB = ''
  let userD = ''
  let spaceA = ''
  let spaceB = ''

  beforeAll(async () => {
    input.succeeds(
      'postgres',
      'postgres',
      `INSERT INTO invitation (id,space_id,email,inviter_id,role,status,expires_at,created_at) VALUES
        ('${IDS.inviteA}','${input.spaceA}','${EMAIL.a}','${input.userA}','member','pending',now() + interval '1 day',now()),
        ('${IDS.inviteB}','${input.spaceA}','${EMAIL.b}','${input.userA}','member','pending',now() + interval '1 day',now()),
        ('${IDS.inviteC}','${input.spaceA}','${EMAIL.c}','${input.userA}','member','pending',now() + interval '1 day',now()),
        ('${IDS.inviteD}','${input.spaceA}','${EMAIL.d}','${input.userA}','member','pending',now() + interval '1 day',now());`,
    )
    server = startRecordApiServer({
      ...process.env,
      PORT: '0',
      ORCH_RECORD_URL: input.actorUrl,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
      RECORD_HUB_URL: 'http://127.0.0.1',
    })
    origin = `http://127.0.0.1:${server.port}`
    const signUp = async (email: string, name: string) => {
      const response = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, name, password: SIGN_UP_AUTH.password }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { token: string; user: { id: string } }
      const whoami = await fetch(`${origin}/v1/whoami`, { headers: headers(body.token) })
      const identity = (await whoami.json()) as {
        user: { id: string }
        activeSpaceId: string
      }
      return { token: body.token, userId: identity.user.id, spaceId: identity.activeSpaceId }
    }
    const a = await signUp(EMAIL.a, 'Board API A')
    const b = await signUp(EMAIL.b, 'Board API B')
    const c = await signUp(EMAIL.c, 'Board API C')
    const signedD = await recordAuth(input.actorUrl).api.signUpEmail({
      body: { email: EMAIL.d, name: 'Board API D', password: SIGN_UP_AUTH.password },
    })
    if (!signedD.token) throw new Error('board API D has no bearer token')
    tokenA = a.token
    tokenB = b.token
    tokenC = c.token
    tokenD = signedD.token
    userA = a.userId
    userB = b.userId
    userD = signedD.user.id
    spaceA = a.spaceId
    spaceB = b.spaceId
    input.succeeds(
      'postgres',
      'postgres',
      `INSERT INTO project (id,space_id,name,key_prefixes,created_at) VALUES
        ('${IDS.project}','${spaceA}','${PROJECT}',ARRAY['BAPI'],now()),
        ('${IDS.projectTwo}','${spaceB}','${PROJECT_TWO}',ARRAY['BAPI2'],now());
       INSERT INTO membership (id,space_id,user_id,role,permission,created_at) VALUES
        ('${IDS.memberB}','${spaceA}','${userB}','member','write',now()),
        ('${IDS.memberA2}','${spaceB}','${userA}','member','write',now()),
        ('${IDS.memberRead}','${spaceA}','${userD}','member','read',now());`,
    )
  })

  afterAll(() => {
    server?.stop()
  })

  const post = (token: string, body: Record<string, unknown>) =>
    fetch(`${origin}/v1/board/messages`, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify(body),
    })

  /** Distinct per case so the author rate cap cannot make a case depend on earlier posts. */
  const caseSession = (label: string) => `board-api-${label}`

  const notice = (
    id: string,
    audience: string,
    authorSession: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    kind: 'notice',
    audience,
    title: `title-${id.slice(0, 8)}`,
    body: `body-${id}`,
    expiresAt,
    authorSession,
    ...extra,
  })

  const cacheStore = (session: string) => {
    const store = new Database(':memory:')
    applyMigrations(store)
    store
      .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
      .run(BOARD_HOSTED_ADOPTED_KEY, '1')
    store
      .query(
        `INSERT INTO presence
         (session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
         VALUES (?,'claude','architect','machine-b',?,'/tmp',NULL,?,?)`,
      )
      .run(session, PROJECT, '2026-10-05T00:00:00.000Z', '2098-01-01T00:00:00.000Z')
    return store
  }

  const cacheClient = (token: string): RecordApiClient => postgresBoardCacheClient(origin, token)

  registerBoardAdoptionProof({
    origin: () => origin,
    token: () => tokenA,
    userId: () => userA,
    project: PROJECT,
    expiresAt,
    caseSession,
    succeeds: input.succeeds,
  })

  test('two machine caches deliver a shared notice once and keep another user operator notice out', async () => {
    const sessionA = caseSession('machine-a')
    const sessionB = caseSession('machine-b')
    const storeA = cacheStore(sessionA)
    const storeB = cacheStore(sessionB)
    try {
      const projectNotice = newRecordId()
      expect(
        (await post(tokenA, notice(projectNotice, `project:${PROJECT}`, sessionA))).status,
      ).toBe(200)
      const clientA = cacheClient(tokenA)
      const clientB = cacheClient(tokenB)
      expect(
        await refreshHostedBoard({
          budgetMs: 2_000,
          env: { ORCH_RECORD_API_URL: origin },
          client: clientA,
          database: storeA,
        }),
      ).toBe('success')
      expect(
        await refreshHostedBoard({
          budgetMs: 2_000,
          env: { ORCH_RECORD_API_URL: origin },
          client: clientB,
          database: storeB,
        }),
      ).toBe('success')
      const delivered = claimCachedHosted(
        sessionB,
        false,
        Date.parse('2098-01-01T00:00:00.000Z'),
        storeB,
      )
      expect(delivered.map((row) => row.id)).toEqual([projectNotice])
      await markCachedHostedDelivered(sessionB, [projectNotice], {
        client: clientB,
        database: storeB,
        clock: Date.parse('2098-01-01T00:00:00.000Z'),
      })
      expect(
        claimCachedHosted(sessionB, false, Date.parse('2098-01-01T00:00:00.000Z'), storeB),
      ).toEqual([])
      const status = await json(
        await fetch(`${origin}/v1/board/messages/${projectNotice}/status`, {
          headers: headers(tokenA),
        }),
      )
      expect(
        (status.receipts as Array<{ readerSession: string }>).map((row) => row.readerSession),
      ).toContain(sessionB)

      const operatorNotice = newRecordId()
      expect((await post(tokenA, notice(operatorNotice, 'operator', sessionA))).status).toBe(200)
      await refreshHostedBoard({
        budgetMs: 2_000,
        env: { ORCH_RECORD_API_URL: origin },
        client: clientB,
        database: storeB,
      })
      expect(
        storeB.query('SELECT 1 FROM hosted_board_message_cache WHERE id=?').get(operatorNotice),
      ).toBeNull()
    } finally {
      storeA.close()
      storeB.close()
    }
  })

  test('one machine cache changes owners and exposes only the new user view', async () => {
    const session = caseSession('cache-user-switch')
    const store = cacheStore(session)
    try {
      const shared = newRecordId()
      const operatorA = newRecordId()
      const operatorB = newRecordId()
      expect((await post(tokenA, notice(shared, `project:${PROJECT}`, session))).status).toBe(200)
      expect((await post(tokenA, notice(operatorA, 'operator', session))).status).toBe(200)
      expect((await post(tokenB, notice(operatorB, 'operator', session))).status).toBe(200)

      expect(
        await refreshHostedBoard({
          budgetMs: 2_000,
          env: { ORCH_RECORD_API_URL: origin },
          client: cacheClient(tokenA),
          database: store,
        }),
      ).toBe('success')
      expect(
        store.query('SELECT 1 FROM hosted_board_message_cache WHERE id=?').get(operatorA),
      ).not.toBeNull()

      expect(
        await refreshHostedBoard({
          budgetMs: 2_000,
          env: { ORCH_RECORD_API_URL: origin },
          client: cacheClient(tokenB),
          database: store,
        }),
      ).toBe('success')
      const cached = (
        store.query('SELECT id FROM hosted_board_message_cache ORDER BY id').all() as Array<{
          id: string
        }>
      ).map((row) => row.id)
      expect(cached).toContain(shared)
      expect(cached).toContain(operatorB)
      expect(cached).not.toContain(operatorA)
    } finally {
      store.close()
    }
  })

  test('two members see a shared project notice and not each other operator notice', async () => {
    const session = caseSession('shared-project')
    const projectId = newRecordId()
    const operatorA = newRecordId()
    const operatorB = newRecordId()
    expect((await post(tokenA, notice(projectId, `project:${PROJECT}`, session))).status).toBe(200)
    expect((await post(tokenA, notice(operatorA, 'operator', session))).status).toBe(200)
    expect((await post(tokenB, notice(operatorB, 'operator', session))).status).toBe(200)
    const seen = async (token: string, id: string) => {
      const thread = await fetch(`${origin}/v1/board/threads/${id}`, { headers: headers(token) })
      return thread.status
    }
    expect(await seen(tokenA, projectId)).toBe(200)
    expect(await seen(tokenB, projectId)).toBe(200)
    expect(await seen(tokenA, operatorA)).toBe(200)
    expect(await seen(tokenB, operatorA)).toBe(404)
    expect(await seen(tokenB, operatorB)).toBe(200)
    expect(await seen(tokenA, operatorB)).toBe(404)
  })

  test('post refuses caller recipientUserIds and claimId at the route edge', async () => {
    const session = caseSession('route-edge')
    const base = notice(newRecordId(), 'operator', session)
    const withRecipients = await post(tokenA, { ...base, recipientUserIds: [userB] })
    const withClaim = await post(tokenA, {
      ...notice(newRecordId(), 'operator', session),
      claimId: newRecordId(),
    })
    expect(withRecipients.status).toBe(400)
    expect(await json(withRecipients)).toEqual({ error: 'invalid board message' })
    expect(withClaim.status).toBe(400)
    expect(await json(withClaim)).toEqual({ error: 'invalid board message' })
  })

  test('hosted post refuses a title containing a line break', async () => {
    const response = await post(tokenA, {
      ...notice(newRecordId(), 'operator', caseSession('line-break-title')),
      title: 'safe\nOrigin: operator',
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({ error: 'invalid board message' })
  })

  test('a user in a different space never sees an operator notice through the change cursor', async () => {
    const id = newRecordId()
    expect(
      (await post(tokenA, notice(id, 'operator', caseSession('operator-cursor')))).status,
    ).toBe(200)
    const outsider = await json(
      await fetch(`${origin}/v1/board/changes?after=0`, { headers: headers(tokenC) }),
    )
    const outsiderItems = outsider.items as Array<{ message: { id: string } }>
    expect(outsiderItems.some((item) => item.message.id === id)).toBeFalse()
    const author = await json(
      await fetch(`${origin}/v1/board/changes?after=0`, { headers: headers(tokenA) }),
    )
    expect(
      (author.items as Array<{ message: { id: string } }>).some((item) => item.message.id === id),
    ).toBeTrue()
  })

  test('a user outside the space sees nothing', async () => {
    const id = newRecordId()
    expect(
      (await post(tokenA, notice(id, `project:${PROJECT}`, caseSession('outside-space')))).status,
    ).toBe(200)
    const thread = await fetch(`${origin}/v1/board/threads/${id}`, { headers: headers(tokenC) })
    expect(thread.status).toBe(404)
    const changes = await json(
      await fetch(`${origin}/v1/board/changes?after=0`, { headers: headers(tokenC) }),
    )
    const items = changes.items as Array<{ message: { id: string } }>
    expect(items.some((item) => item.message.id === id)).toBeFalse()
  })

  test('post is idempotent by id and refuses the same id with different content', async () => {
    const id = newRecordId()
    const body = notice(id, `project:${PROJECT}`, caseSession('idempotent'))
    const first = await post(tokenA, body)
    const again = await post(tokenA, body)
    const different = await post(tokenA, { ...body, body: 'other' })
    expect(first.status).toBe(200)
    expect(again.status).toBe(200)
    expect(((await again.json()) as { id: string }).id).toBe(id)
    expect(different.status).toBe(409)
  })

  test('a machine audience and a suggestion are refused', async () => {
    const session = caseSession('refused-kinds')
    const machine = await post(tokenA, notice(newRecordId(), 'machine:host', session))
    expect(machine.status).toBe(400)
    expect(JSON.stringify(await machine.json())).toContain('machine audiences')
    const suggestion = await fetch(`${origin}/v1/board/messages`, {
      method: 'PUT',
      headers: headers(tokenA),
      body: JSON.stringify({ ...notice(newRecordId(), 'operator', session), kind: 'suggestion' }),
    })
    expect(suggestion.status).toBe(400)
  })

  test('reply, accept, and a second accept', async () => {
    const questionId = newRecordId()
    const replyId = newRecordId()
    const asked = await fetch(`${origin}/v1/board/messages`, {
      method: 'PUT',
      headers: headers(tokenA),
      body: JSON.stringify({
        id: questionId,
        kind: 'question',
        audience: `project:${PROJECT}`,
        title: 'Question',
        body: 'What?',
        expiresAt,
        authorSession: caseSession('reply-accept'),
      }),
    })
    expect(asked.status).toBe(200)
    const replied = await fetch(`${origin}/v1/board/messages/${questionId}/replies`, {
      method: 'POST',
      headers: headers(tokenB),
      body: JSON.stringify({
        id: replyId,
        body: 'Answer',
        authorSession: caseSession('reply-accept-answer'),
      }),
    })
    expect(replied.status).toBe(200)
    const accepted = await fetch(`${origin}/v1/board/messages/${questionId}/accept`, {
      method: 'POST',
      headers: headers(tokenA),
      body: JSON.stringify({ replyId, authorSession: caseSession('reply-accept') }),
    })
    expect(accepted.status).toBe(200)
    const again = await fetch(`${origin}/v1/board/messages/${questionId}/accept`, {
      method: 'POST',
      headers: headers(tokenA),
      body: JSON.stringify({ replyId, authorSession: caseSession('reply-accept') }),
    })
    expect(again.status).toBe(400)
    expect(JSON.stringify(await again.json())).toContain('final')
  })

  test('the filing lease refuses a concurrent take', async () => {
    const questionId = newRecordId()
    const replyId = newRecordId()
    expect(
      (
        await fetch(`${origin}/v1/board/messages`, {
          method: 'PUT',
          headers: headers(tokenA),
          body: JSON.stringify({
            id: questionId,
            kind: 'question',
            audience: `project:${PROJECT}`,
            title: 'File',
            body: 'Q',
            expiresAt,
            authorSession: caseSession('filing-lease'),
          }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${origin}/v1/board/messages/${questionId}/replies`, {
          method: 'POST',
          headers: headers(tokenB),
          body: JSON.stringify({
            id: replyId,
            body: 'A',
            authorSession: caseSession('filing-lease-answer'),
          }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${origin}/v1/board/messages/${questionId}/accept`, {
          method: 'POST',
          headers: headers(tokenA),
          body: JSON.stringify({ replyId, authorSession: caseSession('filing-lease') }),
        })
      ).status,
    ).toBe(200)
    const take = () =>
      fetch(`${origin}/v1/board/messages/${questionId}/filing-lease`, {
        method: 'POST',
        headers: headers(tokenA),
        body: JSON.stringify({ authorSession: caseSession('filing-lease') }),
      })
    const [first, second] = await Promise.all([take(), take()])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 409])
  })

  test('receipts are per reader and idempotent', async () => {
    const id = newRecordId()
    expect(
      (await post(tokenA, notice(id, `project:${PROJECT}`, caseSession('receipts')))).status,
    ).toBe(200)
    const put = (token: string, session: string) =>
      fetch(`${origin}/v1/board/receipts`, {
        method: 'PUT',
        headers: headers(token),
        body: JSON.stringify({
          messageId: id,
          readerSession: session,
          audienceAtPosting: true,
          delivered: true,
        }),
      })
    const first = await put(tokenA, 'reader-a')
    const again = await put(tokenA, 'reader-a')
    const other = await put(tokenB, 'reader-b')
    expect(first.status).toBe(200)
    expect(again.status).toBe(200)
    expect(other.status).toBe(200)
    const firstBody = await json(first)
    const againBody = await json(again)
    expect(firstBody.deliveredAt).toBe(againBody.deliveredAt)
    expect(firstBody.readerUserId).toBe(userA)
    expect((await json(other)).readerUserId).toBe(userB)
  })

  test('status shows all receipts to the author, only the caller receipt to a reader, and 404 outside the project', async () => {
    const id = newRecordId()
    expect(
      (await post(tokenA, notice(id, `project:${PROJECT}`, caseSession('status-author')))).status,
    ).toBe(200)
    const receipt = (token: string, readerSession: string) =>
      fetch(`${origin}/v1/board/receipts`, {
        method: 'PUT',
        headers: headers(token),
        body: JSON.stringify({
          messageId: id,
          readerSession,
          audienceAtPosting: true,
          delivered: true,
        }),
      })
    expect((await receipt(tokenA, 'status-author-reader')).status).toBe(200)
    expect((await receipt(tokenB, 'status-member-reader')).status).toBe(200)
    const status = (token: string) =>
      fetch(`${origin}/v1/board/messages/${id}/status`, { headers: headers(token) })
    const author = await status(tokenA)
    const reader = await status(tokenB)
    const outsider = await status(tokenC)
    expect(author.status).toBe(200)
    expect(((await json(author)).receipts as unknown[]).length).toBe(2)
    expect(reader.status).toBe(200)
    const readerReceipts = (await json(reader)).receipts as Array<{ readerUserId: string }>
    expect(readerReceipts).toEqual([{ ...(readerReceipts[0] ?? {}), readerUserId: userB }])
    expect(outsider.status).toBe(404)
  })

  test('the change cursor returns every visible change once including an update', async () => {
    const session = caseSession('change-cursor')
    const firstId = newRecordId()
    const secondId = newRecordId()
    expect((await post(tokenA, notice(firstId, `project:${PROJECT}`, session))).status).toBe(200)
    expect((await post(tokenA, notice(secondId, `project:${PROJECT}`, session))).status).toBe(200)
    const page = async (after: string) =>
      json(
        await fetch(`${origin}/v1/board/changes?after=${after}&limit=1`, {
          headers: headers(tokenA),
        }),
      )
    const seen = new Set<string>()
    let after = '0'
    for (let i = 0; i < 50; i++) {
      const body = await page(after)
      const items = body.items as Array<{ message: { id: string; revision: string } }>
      if (items.length === 0) break
      for (const item of items) seen.add(`${item.message.id}:${item.message.revision}`)
      after = String(body.highestRevision)
    }
    expect([...seen].some((entry) => entry.startsWith(`${firstId}:`))).toBeTrue()
    expect([...seen].some((entry) => entry.startsWith(`${secondId}:`))).toBeTrue()
    const withdrawn = await fetch(`${origin}/v1/board/messages/${firstId}/withdraw`, {
      method: 'POST',
      headers: headers(tokenA),
      body: JSON.stringify({}),
    })
    expect(withdrawn.status).toBe(200)
    const updatePage = await page(after)
    expect(updatePage.userId).toBe(userA)
    const updated = updatePage.items as Array<{
      message: { id: string; withdrawnAt: string | null }
    }>
    expect(
      updated.some((item) => item.message.id === firstId && item.message.withdrawnAt),
    ).toBeTrue()
  })

  test('two concurrent writers are visible to a cursor reader', async () => {
    const session = caseSession('concurrent-writers')
    const left = newRecordId()
    const right = newRecordId()
    const [first, second] = await Promise.all([
      post(tokenA, notice(left, `project:${PROJECT}`, session)),
      post(tokenA, notice(right, `project:${PROJECT}`, session)),
    ])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const changes = await json(
      await fetch(`${origin}/v1/board/changes?after=0&limit=100`, { headers: headers(tokenA) }),
    )
    const ids = (changes.items as Array<{ message: { id: string } }>).map((item) => item.message.id)
    expect(ids).toContain(left)
    expect(ids).toContain(right)
  })

  test('claim take, renewal, live conflict with notice, lapsed takeover, release, and release by task key', async () => {
    const take = (token: string, body: Record<string, unknown>) =>
      fetch(`${origin}/v1/board/claims`, {
        method: 'PUT',
        headers: headers(token),
        body: JSON.stringify(body),
      })
    const liveId = newRecordId()
    const taken = await take(tokenA, {
      id: liveId,
      project: PROJECT,
      subject: 'resource:gpu',
      holderSession: 'holder-a',
      durationMs: 60_000,
    })
    expect(taken.status).toBe(200)
    expect((await json(taken)).action).toBe('taken')
    const renewed = await fetch(`${origin}/v1/board/claims/${liveId}/renew`, {
      method: 'POST',
      headers: headers(tokenA),
      body: JSON.stringify({ holderSession: 'holder-a' }),
    })
    expect(renewed.status).toBe(200)
    const conflict = await take(tokenB, {
      id: newRecordId(),
      project: PROJECT,
      subject: 'resource:gpu',
      holderSession: 'holder-b',
    })
    expect(conflict.status).toBe(409)
    const conflictBody = JSON.stringify(await conflict.json())
    expect(conflictBody).toContain(userA)
    const notices = await json(
      await fetch(`${origin}/v1/board/changes?after=0&limit=100`, { headers: headers(tokenA) }),
    )
    const told = (
      notices.items as Array<{ message: { audience: string; claimId: string | null } }>
    ).some(
      (item) => item.message.audience === 'session:holder-a' && item.message.claimId === liveId,
    )
    expect(told).toBeTrue()
    const lapsedId = newRecordId()
    const short = await take(tokenA, {
      id: lapsedId,
      project: PROJECT,
      subject: 'task:BAPI-1',
      holderSession: 'holder-a',
      durationMs: 1,
    })
    expect(short.status).toBe(200)
    await Bun.sleep(20)
    const successor = newRecordId()
    const takeover = await take(tokenB, {
      id: successor,
      project: PROJECT,
      subject: 'task:BAPI-1',
      holderSession: 'holder-b',
    })
    expect(takeover.status).toBe(200)
    const takeoverBody = await json(takeover)
    expect(takeoverBody.action).toBe('taken-over')
    const listed = await json(
      await fetch(`${origin}/v1/board/claims?project=${PROJECT}`, { headers: headers(tokenA) }),
    )
    const claims = listed.claims as Array<{
      id: string
      closeReason: string | null
      supersededByClaimId: string | null
      previousClaimIds: string[]
    }>
    const old = claims.find((claim) => claim.id === lapsedId)
    expect(old?.closeReason).toBe('lapsed')
    expect(old?.supersededByClaimId).toBe(successor)
    expect(claims.find((claim) => claim.id === successor)?.previousClaimIds).toContain(lapsedId)
    const released = await fetch(`${origin}/v1/board/claims/${liveId}/release`, {
      method: 'POST',
      headers: headers(tokenA),
      body: JSON.stringify({ holderSession: 'holder-a' }),
    })
    expect(released.status).toBe(200)
    const taskId = newRecordId()
    expect(
      (
        await take(tokenA, {
          id: taskId,
          project: PROJECT,
          subject: 'task:BAPI-9',
          holderSession: 'holder-a',
        })
      ).status,
    ).toBe(200)
    const byTask = await fetch(`${origin}/v1/board/claims/release-task`, {
      method: 'POST',
      headers: headers(tokenA),
      body: JSON.stringify({ project: PROJECT, key: 'BAPI-9' }),
    })
    expect(byTask.status).toBe(200)
    expect((await json(byTask)).released).toBe(1)
  })

  test('a user bound through the API sees a project in a second space', async () => {
    const switched = await fetch(`${origin}/v1/active-space`, {
      method: 'PUT',
      headers: headers(tokenA),
      body: JSON.stringify({ spaceId: spaceA }),
    })
    expect(switched.status).toBe(200)
    const id = newRecordId()
    const posted = await post(
      tokenA,
      notice(id, `project:${PROJECT_TWO}`, caseSession('second-space')),
    )
    expect(posted.status).toBe(200)
    const thread = await fetch(`${origin}/v1/board/threads/${id}`, { headers: headers(tokenA) })
    expect(thread.status).toBe(200)
  })

  test('a row-level security denial is a named refusal not a server error', async () => {
    const posted = await post(
      tokenD,
      notice(newRecordId(), `project:${PROJECT}`, caseSession('rls-denial')),
    )
    expect(posted.status).toBe(400)
    expect(JSON.stringify(await posted.json())).toContain('row-level security')
  })

  test('the author rate cap refuses a further post for one session and accepts another session', async () => {
    const capped = caseSession('rate-cap')
    const other = caseSession('rate-cap-other')
    for (let index = 0; index < BOARD_POST_RATE_LIMIT; index++) {
      expect((await post(tokenA, notice(newRecordId(), 'operator', capped))).status).toBe(200)
    }
    const exceeded = await post(tokenA, notice(newRecordId(), 'operator', capped))
    expect(exceeded.status).toBe(429)
    expect(JSON.stringify(await exceeded.json())).toContain(
      'retry after the ten-minute author window',
    )
    expect((await post(tokenA, notice(newRecordId(), 'operator', other))).status).toBe(200)
  })

  const askAndAnswer = async (session: string) => {
    const questionId = newRecordId()
    const replyId = newRecordId()
    expect(
      (
        await fetch(`${origin}/v1/board/messages`, {
          method: 'PUT',
          headers: headers(tokenA),
          body: JSON.stringify({
            id: questionId,
            kind: 'question',
            audience: `project:${PROJECT}`,
            title: 'Q',
            body: 'Q',
            expiresAt,
            authorSession: session,
          }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${origin}/v1/board/messages/${questionId}/replies`, {
          method: 'POST',
          headers: headers(tokenB),
          body: JSON.stringify({ id: replyId, body: 'A', authorSession: `${session}-answer` }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${origin}/v1/board/messages/${questionId}/accept`, {
          method: 'POST',
          headers: headers(tokenA),
          body: JSON.stringify({ replyId, authorSession: session }),
        })
      ).status,
    ).toBe(200)
    return questionId
  }

  const seedOwnedRun = (ownerUserId: string) => {
    const machineId = newRecordId()
    const runId = newRecordId()
    input.succeeds(
      'postgres',
      'postgres',
      `INSERT INTO machine (id, user_id, name, registered_at, last_seen)
         VALUES ('${machineId}', '${ownerUserId}', 'board-api-machine', now(), now());
       INSERT INTO run (
         id, space_id, project_id, machine_id, local_id, started_by_user_id, started_at, agent, job,
         prompt_sha, prompt_bytes, prompt_head, probe, status, turn, no_failover,
         automatic_failover, work_preserved, created_at, updated_at
       ) VALUES (
         '${runId}', '${spaceA}', '${IDS.project}', '${machineId}', 1, '${ownerUserId}',
         now(), 'proof', 'proof', 'a', 1, 'a', false, 'ok', 1, false, false, false, now(), now()
       );`,
    )
    return { machineId, runId }
  }

  test('reply twice with the same id to a project-scoped thread is idempotent', async () => {
    const session = caseSession('reply-idempotent')
    const questionId = newRecordId()
    const replyId = newRecordId()
    expect(
      (
        await fetch(`${origin}/v1/board/messages`, {
          method: 'PUT',
          headers: headers(tokenA),
          body: JSON.stringify({
            id: questionId,
            kind: 'question',
            audience: `project:${PROJECT}`,
            title: 'Idempotent reply',
            body: 'Q',
            expiresAt,
            authorSession: session,
          }),
        })
      ).status,
    ).toBe(200)
    const replyBody = { id: replyId, body: 'Same answer', authorSession: `${session}-answer` }
    const reply = (body: Record<string, unknown>) =>
      fetch(`${origin}/v1/board/messages/${questionId}/replies`, {
        method: 'POST',
        headers: headers(tokenB),
        body: JSON.stringify(body),
      })
    const first = await reply(replyBody)
    const again = await reply(replyBody)
    const different = await reply({ ...replyBody, body: 'Other answer' })
    expect(first.status).toBe(200)
    expect(again.status).toBe(200)
    expect(((await again.json()) as { id: string }).id).toBe(replyId)
    expect(different.status).toBe(409)
  })

  test('complete twice with different note ids keeps the first', async () => {
    const session = caseSession('filing-complete-twice')
    const questionId = await askAndAnswer(session)
    expect(
      (
        await fetch(`${origin}/v1/board/messages/${questionId}/filing-lease`, {
          method: 'POST',
          headers: headers(tokenA),
          body: JSON.stringify({ authorSession: session }),
        })
      ).status,
    ).toBe(200)
    const firstNote = newRecordId()
    const secondNote = newRecordId()
    const complete = (noteId: string) =>
      fetch(`${origin}/v1/board/messages/${questionId}/filing-lease/complete`, {
        method: 'POST',
        headers: headers(tokenA),
        body: JSON.stringify({ noteId, authorSession: session }),
      })
    expect((await complete(firstNote)).status).toBe(200)
    expect((await complete(secondNote)).status).toBe(409)
    const thread = await json(
      await fetch(`${origin}/v1/board/threads/${questionId}`, { headers: headers(tokenA) }),
    )
    expect((thread.root as { noteId: string }).noteId).toBe(firstNote)
    expect((thread.root as { notePendingError: string | null }).notePendingError).toBeNull()
  })

  test('fail after complete is refused and leaves no error', async () => {
    const session = caseSession('filing-fail-after-complete')
    const questionId = await askAndAnswer(session)
    expect(
      (
        await fetch(`${origin}/v1/board/messages/${questionId}/filing-lease`, {
          method: 'POST',
          headers: headers(tokenA),
          body: JSON.stringify({ authorSession: session }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${origin}/v1/board/messages/${questionId}/filing-lease/complete`, {
          method: 'POST',
          headers: headers(tokenA),
          body: JSON.stringify({ noteId: newRecordId(), authorSession: session }),
        })
      ).status,
    ).toBe(200)
    const before = await json(
      await fetch(`${origin}/v1/board/threads/${questionId}`, { headers: headers(tokenA) }),
    )
    const pendingBefore = (before.root as { notePendingError: string | null }).notePendingError
    expect(pendingBefore).toBeNull()
    const failed = await fetch(`${origin}/v1/board/messages/${questionId}/filing-lease/fail`, {
      method: 'POST',
      headers: headers(tokenA),
      body: JSON.stringify({ error: 'hub unavailable', authorSession: session }),
    })
    expect(failed.status).toBe(409)
    const thread = await json(
      await fetch(`${origin}/v1/board/threads/${questionId}`, { headers: headers(tokenA) }),
    )
    expect((thread.root as { notePendingError: string | null }).notePendingError).toBe(
      pendingBefore,
    )
  })

  test('fail without a take is refused', async () => {
    const session = caseSession('filing-fail-without-take')
    const questionId = await askAndAnswer(session)
    const before = await json(
      await fetch(`${origin}/v1/board/threads/${questionId}`, { headers: headers(tokenA) }),
    )
    const pendingBefore = (before.root as { notePendingError: string | null }).notePendingError
    const failed = await fetch(`${origin}/v1/board/messages/${questionId}/filing-lease/fail`, {
      method: 'POST',
      headers: headers(tokenA),
      body: JSON.stringify({ error: 'hub unavailable', authorSession: session }),
    })
    expect(failed.status).toBe(409)
    expect(JSON.stringify(await failed.json())).toContain('not held')
    const thread = await json(
      await fetch(`${origin}/v1/board/threads/${questionId}`, { headers: headers(tokenA) }),
    )
    expect((thread.root as { notePendingError: string | null }).notePendingError).toBe(
      pendingBefore,
    )
  })

  test('filing-fail secret-shaped error is refused without echoing the text', async () => {
    const session = caseSession('filing-fail-secret')
    const questionId = await askAndAnswer(session)
    expect(
      (
        await fetch(`${origin}/v1/board/messages/${questionId}/filing-lease`, {
          method: 'POST',
          headers: headers(tokenA),
          body: JSON.stringify({ authorSession: session }),
        })
      ).status,
    ).toBe(200)
    const before = await json(
      await fetch(`${origin}/v1/board/threads/${questionId}`, { headers: headers(tokenA) }),
    )
    const pendingBefore = (before.root as { notePendingError: string | null }).notePendingError
    const secret = 'password=supersecretvalue'
    const failed = await fetch(`${origin}/v1/board/messages/${questionId}/filing-lease/fail`, {
      method: 'POST',
      headers: headers(tokenA),
      body: JSON.stringify({ error: secret, authorSession: session }),
    })
    expect(failed.status).toBe(400)
    const text = JSON.stringify(await failed.json())
    expect(text).toContain('secret-shaped')
    expect(text).not.toContain(secret)
    const thread = await json(
      await fetch(`${origin}/v1/board/threads/${questionId}`, { headers: headers(tokenA) }),
    )
    const pendingAfter = (thread.root as { notePendingError: string | null }).notePendingError
    expect(pendingAfter).toBe(pendingBefore)
    expect(`${pendingAfter ?? ''}`).not.toContain(secret)
    expect(JSON.stringify(thread)).not.toContain(secret)
    const retake = await fetch(`${origin}/v1/board/messages/${questionId}/filing-lease`, {
      method: 'POST',
      headers: headers(tokenA),
      body: JSON.stringify({ authorSession: session }),
    })
    expect(retake.status).toBe(409)
    expect(JSON.stringify(await retake.json())).toContain('in progress')
  })

  test('a post naming another user run is refused', async () => {
    const { runId } = seedOwnedRun(userB)
    const posted = await post(
      tokenA,
      notice(newRecordId(), 'operator', caseSession('foreign-run-post'), { authorRunId: runId }),
    )
    expect(posted.status).toBe(400)
    expect(JSON.stringify(await posted.json())).toContain('authorRunId')
  })

  test('a claim take naming another user run is refused', async () => {
    const { runId } = seedOwnedRun(userB)
    const taken = await fetch(`${origin}/v1/board/claims`, {
      method: 'PUT',
      headers: headers(tokenA),
      body: JSON.stringify({
        id: newRecordId(),
        project: PROJECT,
        subject: `resource:foreign-run-${runId.slice(0, 8)}`,
        holderSession: caseSession('foreign-run-claim'),
        runId,
      }),
    })
    expect(taken.status).toBe(400)
    expect(JSON.stringify(await taken.json())).toContain('runId')
  })

  test('the caller own run and machine are accepted', async () => {
    const { machineId, runId } = seedOwnedRun(userA)
    const posted = await post(
      tokenA,
      notice(newRecordId(), 'operator', caseSession('own-run-post'), {
        authorRunId: runId,
        authorMachineId: machineId,
      }),
    )
    expect(posted.status).toBe(200)
    expect(((await posted.json()) as { origin: { runId: string } }).origin.runId).toBe(runId)
    const taken = await fetch(`${origin}/v1/board/claims`, {
      method: 'PUT',
      headers: headers(tokenA),
      body: JSON.stringify({
        id: newRecordId(),
        project: PROJECT,
        subject: `resource:own-run-${runId.slice(0, 8)}`,
        holderSession: caseSession('own-run-claim'),
        runId,
      }),
    })
    expect(taken.status).toBe(200)
  })
}
