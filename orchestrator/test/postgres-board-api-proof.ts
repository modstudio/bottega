import { afterAll, beforeAll, expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import {
  claimCachedHosted,
  markCachedHostedDelivered,
  refreshHostedBoard,
} from '../src/board/board-hosted-cache.ts'
import { BOARD_POST_RATE_LIMIT } from '../src/board/board-policy.ts'
import type { RecordApiClient } from '../src/record/record-api-client.ts'
import { startRecordApiServer } from '../src/record/record-api-server.ts'
import { noSpaceBuiltIns, recordAuth } from '../src/record/record-auth.ts'
import { SIGN_UP_AUTH } from './fixtures/record-auth-postgres.ts'
import { registerBoardAdoptionProof } from './postgres-board-adoption-proof.ts'
import { notice as boardNotice, expiresAt, headers, json } from './postgres-board-api-values.ts'
import { postgresBoardCacheClient, postgresBoardCacheStore } from './postgres-board-cache-client.ts'
import { registerBoardClaimApiProof } from './postgres-board-claim-api-proof.ts'
import { registerBoardOverviewProof } from './postgres-board-overview-proof.ts'
import { registerBoardPostingProjectProof } from './postgres-board-posting-project-proof.ts'
import { registerBoardRouteEdgeProof } from './postgres-board-route-edge-proof.ts'
import { registerBoardSharedSpaceApiProof } from './postgres-board-shared-space-api-proof.ts'
import { registerBoardStreamProof } from './postgres-board-stream-proof.ts'

type Succeeds = (user: string, password: string, source: string) => string

const IDS = {
  inviteA: '03990000-0000-7000-8000-000000000001',
  inviteB: '03990000-0000-7000-8000-000000000002',
  inviteC: '03990000-0000-7000-8000-000000000003',
  inviteD: '03990000-0000-7000-8000-000000000004',
  project: '03990000-0000-7000-8000-000000000011',
  projectTwo: '03990000-0000-7000-8000-000000000012',
  adoptionProject: '03990000-0000-7000-8000-000000000013',
  originProject: '03990000-0000-7000-8000-000000000019',
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
const ADOPTION_PROJECT = 'board-api-adoption'
const ORIGIN_PROJECT = 'board-api-private-origin'
const PROJECT_IDS: Record<string, string> = {
  [PROJECT]: IDS.project,
  [PROJECT_TWO]: IDS.projectTwo,
  [ADOPTION_PROJECT]: IDS.adoptionProject,
  [ORIGIN_PROJECT]: IDS.originProject,
}
const notice = (
  id: string,
  audience: string,
  authorSession: string,
  extra: Record<string, unknown> = {},
) => {
  const audienceProject = audience.includes(':') ? audience.slice(audience.indexOf(':') + 1) : null
  const namedProject = typeof extra.project === 'string' ? extra.project : audienceProject
  return boardNotice(id, audience, authorSession, {
    ...(namedProject && PROJECT_IDS[namedProject] ? { projectId: PROJECT_IDS[namedProject] } : {}),
    ...extra,
  })
}
export function registerBoardApiProofs(input: {
  actorUrl: string
  spaceA: string
  userA: string
  succeeds: Succeeds
}): void {
  let origin = ''
  let server: Awaited<ReturnType<typeof startRecordApiServer>> | undefined
  let tokenA = ''
  let tokenB = ''
  let tokenC = ''
  let tokenD = ''
  let userA = ''
  let userB = ''
  let userC = ''
  let userD = ''
  let spaceA = ''
  let spaceC = ''
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
    server = await startRecordApiServer({
      ...process.env,
      PORT: '0',
      BOTTEGA_RECORD_URL: input.actorUrl,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
      RECORD_HUB_URL: 'http://127.0.0.1',
    })
    origin = `http://127.0.0.1:${server.port}`
    const auth = recordAuth(
      input.actorUrl,
      process.env,
      undefined,
      undefined,
      undefined,
      noSpaceBuiltIns,
    )
    const signUp = async (email: string, name: string) => {
      const created = await auth.api.signUpEmail({
        body: { email, name, password: SIGN_UP_AUTH.password },
      })
      if (!created.token) throw new Error(`board API ${email} has no bearer token`)
      const session = await auth.api.getSession({ headers: headers(created.token) })
      if (!session?.session.activeOrganizationId)
        throw new Error(`board API ${email} has no active space`)
      return {
        token: created.token,
        userId: created.user.id,
        spaceId: session.session.activeOrganizationId,
      }
    }
    const a = await signUp(EMAIL.a, 'Board API A')
    const b = await signUp(EMAIL.b, 'Board API B')
    const c = await signUp(EMAIL.c, 'Board API C')
    const d = await signUp(EMAIL.d, 'Board API D')
    tokenA = a.token
    tokenB = b.token
    tokenC = c.token
    tokenD = d.token
    userA = a.userId
    userB = b.userId
    userC = c.userId
    userD = d.userId
    spaceA = a.spaceId
    spaceB = b.spaceId
    spaceC = c.spaceId
    input.succeeds(
      'postgres',
      'postgres',
      `INSERT INTO project (id,space_id,name,key_prefixes,created_at) VALUES
        ('${IDS.project}','${spaceA}','${PROJECT}',ARRAY['BAPI'],now()),
        ('${IDS.projectTwo}','${spaceB}','${PROJECT_TWO}',ARRAY['BAPI2'],now()),
        ('${IDS.adoptionProject}','${spaceA}','${ADOPTION_PROJECT}',ARRAY['BAPIA'],now()),
        ('${IDS.originProject}','${spaceB}','${ORIGIN_PROJECT}',ARRAY['BAPIO'],now());
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

  const cacheStore = (session: string) => postgresBoardCacheStore(session, PROJECT)

  const cacheClient = (token: string): RecordApiClient => postgresBoardCacheClient(origin, token)

  registerBoardAdoptionProof({
    origin: () => origin,
    token: () => tokenA,
    userId: () => userA,
    project: ADOPTION_PROJECT,
    projectId: IDS.adoptionProject,
    expiresAt,
    caseSession,
    succeeds: input.succeeds,
  })

  registerBoardOverviewProof({
    origin: () => origin,
    tokenA: () => tokenA,
    tokenB: () => tokenB,
    tokenC: () => tokenC,
    tokenD: () => tokenD,
    userA: () => userA,
    userB: () => userB,
    userD: () => userD,
    succeeds: input.succeeds,
    expiresAt,
    caseSession,
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
          env: { BOTTEGA_RECORD_API_URL: origin },
          client: clientA,
          database: storeA,
        }),
      ).toMatchObject({ status: 'success' })
      expect(
        await refreshHostedBoard({
          budgetMs: 2_000,
          env: { BOTTEGA_RECORD_API_URL: origin },
          client: clientB,
          database: storeB,
        }),
      ).toMatchObject({ status: 'success' })
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
        env: { BOTTEGA_RECORD_API_URL: origin },
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

  registerBoardSharedSpaceApiProof(
    () => origin,
    () => tokenD,
    () => tokenC,
    PROJECT,
    (id) => post(tokenA, notice(id, 'spaces', caseSession('spaces-feed'))),
  )

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
          env: { BOTTEGA_RECORD_API_URL: origin },
          client: cacheClient(tokenA),
          database: store,
        }),
      ).toMatchObject({ status: 'success' })
      expect(
        store.query('SELECT 1 FROM hosted_board_message_cache WHERE id=?').get(operatorA),
      ).not.toBeNull()

      expect(
        await refreshHostedBoard({
          budgetMs: 2_000,
          env: { BOTTEGA_RECORD_API_URL: origin },
          client: cacheClient(tokenB),
          database: store,
        }),
      ).toMatchObject({ status: 'success' })
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

  registerBoardRouteEdgeProof({
    token: () => tokenA,
    recipientUserId: () => userB,
    post,
    caseSession,
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

  registerBoardPostingProjectProof({
    origin: () => origin,
    tokenA: () => tokenA,
    tokenB: () => tokenB,
    tokenD: () => tokenD,
    post,
    caseSession,
    succeeds: input.succeeds,
    project: PROJECT,
    projectTwo: PROJECT_TWO,
    originProject: ORIGIN_PROJECT,
    projectId: IDS.project,
    projectTwoId: IDS.projectTwo,
    originProjectId: IDS.originProject,
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
        projectId: IDS.project,
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
            projectId: IDS.project,
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

  registerBoardClaimApiProof({
    origin: () => origin,
    tokenA: () => tokenA,
    tokenB: () => tokenB,
    userA: () => userA,
    project: PROJECT,
    projectId: IDS.project,
    succeeds: input.succeeds,
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
            projectId: IDS.project,
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
         id, space_id, project_id, machine_id, started_by_user_id, started_at, agent, job,
         prompt_sha, prompt_bytes, prompt_head, probe, status, turn, no_failover,
         automatic_failover, work_preserved, created_at, updated_at
       ) VALUES (
         '${runId}', '${spaceA}', '${IDS.project}', '${machineId}', '${ownerUserId}',
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
            projectId: IDS.project,
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
        projectId: IDS.project,
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
        projectId: IDS.project,
        subject: `resource:own-run-${runId.slice(0, 8)}`,
        holderSession: caseSession('own-run-claim'),
        runId,
      }),
    })
    expect(taken.status).toBe(200)
  })

  registerBoardStreamProof({
    actorUrl: input.actorUrl,
    origin: () => origin,
    streamToken: () => tokenC,
    streamUserId: () => userC,
    writerUserId: () => userA,
    visibleSpaceId: () => spaceA,
    invisibleSpaceId: () => spaceB,
    writerSpaceIds: () => [spaceA, spaceB],
    streamUserHomeSpaceId: () => spaceC,
    postNotice: (body) => post(tokenA, body),
    project: PROJECT,
    projectId: IDS.project,
    admin: (statement) => input.succeeds('postgres', 'postgres', statement),
  })
}
