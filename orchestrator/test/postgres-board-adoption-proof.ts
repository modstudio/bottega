import { expect, test } from 'bun:test'
import { adoptHostedBoard } from '../src/board/board-adoption.ts'
import { db } from '../src/database/db.ts'
import { machineId } from '../src/record/machine-identity.ts'
import type { RecordApiClient } from '../src/record/record-api-client.ts'

type ProofInput = {
  origin(): string
  token(): string
  userId(): string
  project: string
  expiresAt: string
  caseSession(label: string): string
  succeeds(user: string, password: string, source: string): string
}

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
})

function adoptionClient(input: ProofInput): RecordApiClient {
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${input.origin()}${path}`, {
      method,
      headers: headers(input.token()),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const value = (await response.json()) as Record<string, unknown>
    if (!response.ok) throw new Error(String(value.error ?? `record API ${response.status}`))
    return value
  }
  return {
    whoami: async () => call('/v1/whoami'),
    listBoardChanges: async ({ after = '0', limit = 100 }) =>
      call(`/v1/board/changes?after=${after}&limit=${limit}`),
    postBoardMessage: async (body: Parameters<RecordApiClient['postBoardMessage']>[0]) =>
      call('/v1/board/messages', 'PUT', body),
    replyBoardMessage: async (
      rootId: string,
      body: Parameters<RecordApiClient['replyBoardMessage']>[1],
    ) => call(`/v1/board/messages/${rootId}/replies`, 'POST', body),
    putBoardReceipt: async (body: Parameters<RecordApiClient['putBoardReceipt']>[0]) =>
      call('/v1/board/receipts', 'PUT', body),
    takeBoardClaim: async (body: Parameters<RecordApiClient['takeBoardClaim']>[0]) =>
      call('/v1/board/claims', 'PUT', body),
  } as unknown as RecordApiClient
}

function seedLocalBoard(input: ProofInput) {
  const local = db()
  const created = '2026-10-05T10:00:00.000Z'
  const notice = local
    .query(
      `INSERT INTO board_message
       (kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at,
        author_harness,author_project)
       VALUES ('notice','architect',?,?,'Adopt notice','Notice',0,?,?,'claude',?) RETURNING id`,
    )
    .get(
      input.caseSession('adopt-notice'),
      `project:${input.project}`,
      input.expiresAt,
      created,
      input.project,
    ) as { id: number }
  const question = local
    .query(
      `INSERT INTO board_message
       (kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at,
        author_harness,author_project)
       VALUES ('question','architect',?,?,'Adopt question','Question',0,?,?,'claude',?) RETURNING id`,
    )
    .get(
      input.caseSession('adopt-question'),
      `project:${input.project}`,
      input.expiresAt,
      created,
      input.project,
    ) as { id: number }
  local
    .query(
      `INSERT INTO board_message
       (kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at,
        author_harness,author_project,thread_root_id)
       VALUES ('reply','architect',?,NULL,NULL,'Answer',0,NULL,?,'claude',?,?)`,
    )
    .run(input.caseSession('adopt-reply'), created, input.project, question.id)
  local
    .query(
      `INSERT INTO board_claim
       (project,subject_kind,subject_value,holder_kind,holder_session,duration_ms,taken_at,
        renewed_at,lapses_at)
       VALUES (?,'resource','adoption-proof','architect',?,3600000,?,?,?)`,
    )
    .run(
      input.project,
      input.caseSession('adopt-claim'),
      created,
      created,
      new Date(Date.now() + 3_600_000).toISOString(),
    )
  return { local, notice }
}

export function registerBoardAdoptionProof(input: ProofInput): void {
  test('adoption uploads a local notice, question with reply, and claim through hosted routes', async () => {
    const localMachineId = machineId()
    input.succeeds(
      'postgres',
      'postgres',
      `INSERT INTO machine (id,user_id,name,registered_at,last_seen)
       VALUES ('${localMachineId}','${input.userId()}','adoption-machine',now(),now())
       ON CONFLICT (id) DO UPDATE SET user_id=excluded.user_id,last_seen=excluded.last_seen;`,
    )
    const { local, notice } = seedLocalBoard(input)
    expect(
      await adoptHostedBoard({ confirm: 4, database: local, client: adoptionClient(input) }),
    ).toMatchObject({ status: 'adopted', uploaded: 4 })
    const ids = local
      .query<{ local_kind: string; hosted_id: string }, []>(
        'SELECT local_kind,hosted_id FROM board_hosted_adoption_ledger',
      )
      .all()
    const hostedNotice = ids.find((row) => row.local_kind === 'notice')!.hosted_id
    const hostedQuestion = ids.find((row) => row.local_kind === 'question')!.hosted_id
    const noticeRead = await fetch(`${input.origin()}/v1/board/threads/${hostedNotice}`, {
      headers: headers(input.token()),
    })
    const questionRead = await fetch(`${input.origin()}/v1/board/threads/${hostedQuestion}`, {
      headers: headers(input.token()),
    })
    const claimsRead = (await (
      await fetch(`${input.origin()}/v1/board/claims?project=${input.project}`, {
        headers: headers(input.token()),
      })
    ).json()) as { claims: Array<{ subject: { value: string } }> }
    expect(noticeRead.status).toBe(200)
    expect(((await questionRead.json()) as { replies: unknown[] }).replies.length).toBe(1)
    expect(claimsRead.claims.some((row) => row.subject.value === 'adoption-proof')).toBeTrue()
    expect(notice.id).toBeGreaterThan(0)
  })
}
