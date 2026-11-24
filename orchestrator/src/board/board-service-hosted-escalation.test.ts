import { beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { BOARD_CACHE_OWNER_KEY } from './board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import { boardEscalations, boardRequestCountForSession } from './board-service.ts'

beforeEach(() => fixtureProjectRecordId(db()))

test('an incomplete hosted refresh makes the board request count unread', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')

  const result = await boardRequestCountForSession(
    'brief-reader',
    { BOTTEGA_RECORD_API_URL: 'https://record.test' },
    db(),
    async () => ({ status: 'incomplete' as const, applied: 0 }),
  )

  expect(result).toEqual({ unread: 'refresh did not catch up within its budget' })
})

test('hosted acknowledgement escalation returns the cached record id, not a local number', async () => {
  const database = db()
  const clock = Date.parse('2026-11-23T20:00:00.000Z')
  const hostedId = newRecordId()
  const setMeta = database.query('INSERT OR REPLACE INTO schema_meta(key,value) VALUES (?,?)')
  setMeta.run(BOARD_HOSTED_ADOPTED_KEY, '1')
  setMeta.run(BOARD_CACHE_OWNER_KEY, 'hosted-reader')
  setMeta.run('board_hosted_signed_in_user', 'hosted-reader')
  database
    .query(
      `INSERT INTO board_message
       (record_id,number,kind,author_kind,audience,title,body,ack_required,ack_deadline,
        expires_at,created_at,purpose,author_session)
       VALUES (?,777,'notice','architect','operator','local decoy','body',1,?,?,'2026-11-23T18:00:00.000Z','request','local-author')`,
    )
    .run(
      newRecordId(),
      new Date(clock - 1_000).toISOString(),
      new Date(clock + 60_000).toISOString(),
    )
  const hosted = {
    id: hostedId,
    kind: 'notice',
    threadRootId: null,
    title: 'hosted answer',
    body: 'body',
    audience: 'operator',
    origin: { kind: 'architect', session: 'author', harness: 'codex', project: null, runId: null },
    senderTags: [],
    createdAt: '2026-11-23T18:00:00.000Z',
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
    authorUserId: newRecordId(),
    authorSession: 'author',
    ackRequired: true,
    ackDeadline: new Date(clock - 1_000).toISOString(),
  }
  database
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(hostedId, 'notice', null, '1', JSON.stringify(hosted))
  database
    .query(
      `INSERT INTO hosted_board_receipt_cache
       (record_id,message_id,reader_session,reader_run_record_id,audience_at_posting,delivered_at,acknowledged_at,pending_sync)
       VALUES (?,?,?,NULL,1,NULL,NULL,0)`,
    )
    .run(newRecordId(), hostedId, 'hosted-reader')

  const rows = await boardEscalations(clock, {
    env: { BOTTEGA_RECORD_API_URL: 'https://record.test' },
    database,
    refresh: async () => ({ status: 'success', applied: 0 }),
  })
  expect(rows.map(({ subject }) => subject)).toEqual([`board:${hostedId}:hosted-reader`])
  expect(rows[0]?.detail).toContain(hostedId)
  expect(rows[0]?.action).toEndWith(`board status ${hostedId}`)
})
