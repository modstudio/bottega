import { afterAll, beforeAll, expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { recordAuth } from '../src/record/record-auth.ts'
import { startRecordApiServer } from '../src/record/record-api-server.ts'
import { SIGN_UP_AUTH } from './fixtures/record-auth-postgres.ts'

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

  const notice = (id: string, audience: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: 'notice',
    audience,
    title: `title-${id.slice(0, 8)}`,
    body: `body-${id}`,
    expiresAt,
    ...extra,
  })

  test('two members see a shared project notice and not each other operator notice', async () => {
    const projectId = newRecordId()
    const operatorA = newRecordId()
    const operatorB = newRecordId()
    expect((await post(tokenA, notice(projectId, `project:${PROJECT}`))).status).toBe(200)
    expect((await post(tokenA, notice(operatorA, 'operator'))).status).toBe(200)
    expect((await post(tokenB, notice(operatorB, 'operator'))).status).toBe(200)
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

  test('a user outside the space sees nothing', async () => {
    const id = newRecordId()
    expect((await post(tokenA, notice(id, `project:${PROJECT}`))).status).toBe(200)
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
    const body = notice(id, `project:${PROJECT}`)
    const first = await post(tokenA, body)
    const again = await post(tokenA, body)
    const different = await post(tokenA, { ...body, body: 'other' })
    expect(first.status).toBe(200)
    expect(again.status).toBe(200)
    expect(((await again.json()) as { id: string }).id).toBe(id)
    expect(different.status).toBe(409)
  })

  test('a machine audience and a suggestion are refused', async () => {
    const machine = await post(tokenA, notice(newRecordId(), 'machine:host'))
    expect(machine.status).toBe(400)
    expect(JSON.stringify(await machine.json())).toContain('machine audiences')
    const suggestion = await fetch(`${origin}/v1/board/messages`, {
      method: 'PUT',
      headers: headers(tokenA),
      body: JSON.stringify({ ...notice(newRecordId(), 'operator'), kind: 'suggestion' }),
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
        authorSession: 'asker-session',
      }),
    })
    expect(asked.status).toBe(200)
    const replied = await fetch(`${origin}/v1/board/messages/${questionId}/replies`, {
      method: 'POST',
      headers: headers(tokenB),
      body: JSON.stringify({ id: replyId, body: 'Answer', authorSession: 'answer-session' }),
    })
    expect(replied.status).toBe(200)
    const accepted = await fetch(`${origin}/v1/board/messages/${questionId}/accept`, {
      method: 'POST',
      headers: headers(tokenA),
      body: JSON.stringify({ replyId, authorSession: 'asker-session' }),
    })
    expect(accepted.status).toBe(200)
    const again = await fetch(`${origin}/v1/board/messages/${questionId}/accept`, {
      method: 'POST',
      headers: headers(tokenA),
      body: JSON.stringify({ replyId, authorSession: 'asker-session' }),
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
            authorSession: 'lease-asker',
          }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${origin}/v1/board/messages/${questionId}/replies`, {
          method: 'POST',
          headers: headers(tokenB),
          body: JSON.stringify({ id: replyId, body: 'A', authorSession: 'lease-answer' }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${origin}/v1/board/messages/${questionId}/accept`, {
          method: 'POST',
          headers: headers(tokenA),
          body: JSON.stringify({ replyId, authorSession: 'lease-asker' }),
        })
      ).status,
    ).toBe(200)
    const take = () =>
      fetch(`${origin}/v1/board/messages/${questionId}/filing-lease`, {
        method: 'POST',
        headers: headers(tokenA),
        body: JSON.stringify({ authorSession: 'lease-asker' }),
      })
    const [first, second] = await Promise.all([take(), take()])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 409])
  })

  test('receipts are per reader and idempotent', async () => {
    const id = newRecordId()
    expect((await post(tokenA, notice(id, `project:${PROJECT}`))).status).toBe(200)
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

  test('the change cursor returns every visible change once including an update', async () => {
    const firstId = newRecordId()
    const secondId = newRecordId()
    expect((await post(tokenA, notice(firstId, `project:${PROJECT}`))).status).toBe(200)
    expect((await post(tokenA, notice(secondId, `project:${PROJECT}`))).status).toBe(200)
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
    const updated = updatePage.items as Array<{
      message: { id: string; withdrawnAt: string | null }
    }>
    expect(
      updated.some((item) => item.message.id === firstId && item.message.withdrawnAt),
    ).toBeTrue()
  })

  test('two concurrent writers are visible to a cursor reader', async () => {
    const left = newRecordId()
    const right = newRecordId()
    const [first, second] = await Promise.all([
      post(tokenA, notice(left, `project:${PROJECT}`)),
      post(tokenA, notice(right, `project:${PROJECT}`)),
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
    const posted = await post(tokenA, notice(id, `project:${PROJECT_TWO}`))
    expect(posted.status).toBe(200)
    const thread = await fetch(`${origin}/v1/board/threads/${id}`, { headers: headers(tokenA) })
    expect(thread.status).toBe(200)
  })

  test('a row-level security denial is a named refusal not a server error', async () => {
    const posted = await post(tokenD, notice(newRecordId(), `project:${PROJECT}`))
    expect(posted.status).toBe(400)
    expect(JSON.stringify(await posted.json())).toContain('row-level security')
  })
}
