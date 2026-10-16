import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
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

const subjectsUnused = async (): Promise<never> => {
  throw new Error('hosted subjects are unused in the board adoption proof')
}

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
    listProjectSubjects: subjectsUnused,
    addProjectSubject: subjectsUnused,
    renameProjectSubject: subjectsUnused,
    defineProjectSubject: subjectsUnused,
    reorderProjectSubjects: subjectsUnused,
    retireProjectSubject: subjectsUnused,
  } as unknown as RecordApiClient
}

function seedLocalBoard(input: ProofInput) {
  const local = db()
  const created = '2026-10-05T10:00:00.000Z'
  const notice = local
    .query(
      `INSERT INTO board_message
       (record_id,kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at,
        author_harness,author_project)
       VALUES (?,'notice','architect',?,?,'Adopt notice','Notice',0,?,?,'claude',?)
       RETURNING id,record_id`,
    )
    .get(
      newRecordId(),
      input.caseSession('adopt-notice'),
      `session:${input.caseSession('adopt-notice')}`,
      input.expiresAt,
      created,
      input.project,
    ) as { id: number; record_id: string }
  const receiptReader = input.caseSession('adopt-receipt')
  local
    .query(
      `INSERT INTO presence
       (session_id,harness,role,machine,project,cwd,first_seen,last_seen)
       VALUES (?,'claude','architect','adoption-machine',?,'/tmp',?,?)`,
    )
    .run(receiptReader, input.project, created, new Date().toISOString())
  local
    .query(
      `INSERT INTO board_receipt
       (record_id,message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,?,?,1,?,NULL)`,
    )
    .run(newRecordId(), notice.id, receiptReader, created)
  const question = local
    .query(
      `INSERT INTO board_message
       (record_id,kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at,
        author_harness,author_project)
       VALUES (?,'question','architect',?,?,'Adopt question','Question',0,?,?,'claude',?)
       RETURNING id,record_id`,
    )
    .get(
      newRecordId(),
      input.caseSession('adopt-question'),
      `session:${input.caseSession('adopt-question')}`,
      input.expiresAt,
      created,
      input.project,
    ) as { id: number; record_id: string }
  const reply = local
    .query(
      `INSERT INTO board_message
       (record_id,kind,author_kind,author_session,audience,title,body,ack_required,expires_at,created_at,
        author_harness,author_project,thread_root_id)
       VALUES (?,'reply','architect',?,NULL,NULL,'Answer',0,NULL,?,'claude',?,?)
       RETURNING id,record_id`,
    )
    .get(newRecordId(), input.caseSession('adopt-reply'), created, input.project, question.id) as {
    id: number
    record_id: string
  }
  const claim = local
    .query(
      `INSERT INTO board_claim
       (record_id,project,subject_kind,subject_value,holder_kind,holder_session,duration_ms,taken_at,
        renewed_at,lapses_at)
       VALUES (?,?,'resource','adoption-proof','architect',?,3600000,?,?,?)
       RETURNING id,record_id`,
    )
    .get(
      newRecordId(),
      input.project,
      input.caseSession('adopt-claim'),
      created,
      created,
      new Date(Date.now() + 3_600_000).toISOString(),
    ) as { id: number; record_id: string }
  return { local, notice, question, reply, claim, receiptReader }
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
    const { local, notice, question, reply, claim, receiptReader } = seedLocalBoard(input)
    expect(
      await adoptHostedBoard({ confirm: 4, database: local, client: adoptionClient(input) }),
    ).toMatchObject({ status: 'adopted', uploaded: 4 })
    const ledger = local
      .query<{ local_kind: string; source_record_id: string; state: string }, []>(
        `SELECT local_kind,source_record_id,state
         FROM board_hosted_adoption_ledger ORDER BY local_kind`,
      )
      .all()
    expect(ledger).toEqual(
      expect.arrayContaining([
        { local_kind: 'claim', source_record_id: claim.record_id, state: 'uploaded' },
        { local_kind: 'notice', source_record_id: notice.record_id, state: 'uploaded' },
        { local_kind: 'question', source_record_id: question.record_id, state: 'uploaded' },
        { local_kind: 'reply', source_record_id: reply.record_id, state: 'uploaded' },
      ]),
    )
    const noticeRead = await fetch(`${input.origin()}/v1/board/threads/${notice.record_id}`, {
      headers: headers(input.token()),
    })
    const questionRead = await fetch(`${input.origin()}/v1/board/threads/${question.record_id}`, {
      headers: headers(input.token()),
    })
    const claimsRead = (await (
      await fetch(`${input.origin()}/v1/board/claims?project=${input.project}`, {
        headers: headers(input.token()),
      })
    ).json()) as { claims: Array<{ id: string; subject: { value: string } }> }
    expect(noticeRead.status).toBe(200)
    expect(((await noticeRead.json()) as { root: { id: string } }).root.id).toBe(notice.record_id)
    const hostedQuestion = (await questionRead.json()) as {
      root: { id: string }
      replies: Array<{ id: string }>
    }
    expect(hostedQuestion.root.id).toBe(question.record_id)
    expect(hostedQuestion.replies).toEqual([expect.objectContaining({ id: reply.record_id })])
    expect(
      claimsRead.claims.some(
        (row) => row.id === claim.record_id && row.subject.value === 'adoption-proof',
      ),
    ).toBeTrue()
    const changes = await adoptionClient(input).listBoardChanges({ after: '0', limit: 100 })
    expect(
      changes.items
        .find((item) => item.message.id === notice.record_id)
        ?.receipts.some((receipt) => receipt.readerSession === receiptReader),
    ).toBeTrue()
    expect(notice.id).toBeGreaterThan(0)
  })
}
