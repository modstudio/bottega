import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import { markBoardDeliveryDelivered } from './board-push-service.ts'
import { postNotice } from './board-service.ts'

const postingCwd = import.meta.dir

afterEach(() => installRecordApiClient(null))

test('delivery stamps hosted receipt and reach for an uploaded local shadow UUID', async () => {
  const clock = Date.parse('2026-10-07T16:00:00.000Z')
  const reader = 'adopted-shadow-reader'
  db()
    .query(
      `INSERT INTO project(record_id,name,path,settings)
       VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'adopted-delivery-project',?,'{}')`,
    )
    .run(postingCwd)
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','adopted-delivery-project',(SELECT record_id FROM project WHERE name='adopted-delivery-project'),'/tmp',NULL,?,?)`,
    )
    .run(reader, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const local = postNotice(
    { audience: `session:${reader}`, title: 'Adopted', body: 'hosted row shares this UUID' },
    { CLAUDE_CODE_SESSION_ID: 'adopted-author' },
    clock,
    postingCwd,
  )
  const retiredAt = new Date(clock + 1).toISOString()
  db()
    .query('UPDATE board_message SET withdrawn_at=? WHERE record_id=?')
    .run(retiredAt, local.recordId)
  db()
    .query(
      `INSERT INTO board_hosted_adoption_ledger
       (source_record_id,local_kind,state,refusal,created_at,updated_at)
       VALUES (?,'notice','uploaded',NULL,?,?)`,
    )
    .run(local.recordId, retiredAt, retiredAt)
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const authorUserId = newRecordId()
  const hosted = {
    id: local.recordId,
    kind: 'notice',
    purpose: 'information',
    threadRootId: null,
    title: 'Adopted',
    body: 'hosted row shares this UUID',
    audience: `session:${reader}`,
    origin: {
      kind: 'architect',
      session: 'adopted-author',
      harness: 'claude-code',
      project: 'adopted-delivery-project',
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
    authorUserId,
    authorSession: 'adopted-author',
    ackRequired: false,
    ackDeadline: null,
  }
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(hosted.id, hosted.kind, hosted.threadRootId, hosted.revision, JSON.stringify(hosted))
  const receipts: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    putBoardReceipt: async (input) => {
      receipts.push(input.messageId)
      return {
        messageId: input.messageId,
        readerUserId: authorUserId,
        readerSession: input.readerSession,
        audienceAtPosting: input.audienceAtPosting,
        deliveredAt: new Date(clock + 2).toISOString(),
        acknowledgedAt: null,
      }
    },
  })
  const previousUrl = process.env.ORCH_RECORD_API_URL
  process.env.ORCH_RECORD_API_URL = 'https://record.test'
  try {
    await markBoardDeliveryDelivered({
      session: reader,
      ids: [local.recordId],
      clock: clock + 2,
      emissionId: newRecordId(),
      deliveryPoint: 'after-tool-call',
    })
  } finally {
    if (previousUrl === undefined) delete process.env.ORCH_RECORD_API_URL
    else process.env.ORCH_RECORD_API_URL = previousUrl
  }

  expect(receipts).toEqual([local.recordId])
  expect(
    db()
      .query(
        'SELECT delivered_at FROM board_receipt WHERE message_record_id=? AND reader_session=?',
      )
      .get(local.recordId, reader),
  ).toEqual({ delivered_at: null })
  expect(
    db()
      .query('SELECT message_id FROM hosted_board_receipt_cache WHERE message_id=?')
      .get(local.recordId),
  ).toEqual({ message_id: local.recordId })
  expect(
    db()
      .query(
        'SELECT message_source,message_record_id FROM board_reach_delivery WHERE message_record_id=?',
      )
      .all(local.recordId),
  ).toEqual([{ message_source: 'hosted', message_record_id: local.recordId }])
})
