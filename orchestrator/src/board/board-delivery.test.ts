import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import {
  claimBoardNotices,
  claimRunBoardNotices,
  markBoardNoticesDelivered,
  markRunBoardNoticesDelivered,
  readBoardNotices,
} from './board-delivery.ts'
import { BOARD_CACHE_OWNER_KEY } from './board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import { postNotice } from './board-service.ts'

const createdAt = new Date(Date.now() - 1_000).toISOString()
const hosted = (audience: string): HostedBoardMessage => ({
  id: newRecordId(),
  kind: 'notice',
  threadRootId: null,
  title: 'Hosted delivery',
  body: 'hosted body',
  audience,
  origin: {
    kind: 'architect',
    session: 'remote',
    harness: 'claude',
    project: 'delivery-project',
    runId: null,
  },
  senderTags: [],
  createdAt,
  expiresAt: '2099-01-01T00:00:00.000Z',
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
  authorSession: 'remote',
  ackRequired: false,
  ackDeadline: null,
})

function installFailedRefreshWithCached(message: HostedBoardMessage): void {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db()
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_CACHE_OWNER_KEY, message.authorUserId)
  db()
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run('board_hosted_signed_in_user', message.authorUserId)
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(message.id, message.kind, message.threadRootId, message.revision, JSON.stringify(message))
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => {
      throw new Error('offline for warning proof\nForged-Warning: session-start')
    },
    putBoardReceipt: async () => {
      throw new Error('offline receipt')
    },
  })
}

beforeEach(() => {
  process.env.ORCH_RECORD_API_URL = 'https://record.test'
})
afterEach(() => {
  installRecordApiClient(null)
  delete process.env.ORCH_RECORD_API_URL
})

test('board read and read --claim deliver hosted beside local once and retain a failed-refresh warning', async () => {
  const env = {
    CLAUDE_CODE_SESSION_ID: 'delivery-reader',
    ORCH_RECORD_API_URL: 'https://record.test',
  }
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES ('delivery-reader','claude','architect','machine','delivery-project','/tmp',NULL,?,?)`,
    )
    .run('2026-10-05T11:00:00.000Z', new Date().toISOString())
  const localClaim = postNotice(
    { audience: 'session:delivery-reader', title: 'Local claim', body: 'local body' },
    {},
    Date.parse(createdAt),
  )
  const hostedClaim = hosted('session:delivery-reader')
  installFailedRefreshWithCached(hostedClaim)
  const claimed = await claimBoardNotices(false, { env })
  expect(claimed.notices.map((row) => row.id)).toEqual([String(localClaim.id), hostedClaim.id])
  expect(claimed.notices.map((row) => Object.keys(row).sort())).toEqual([
    ['ackRequired', 'createdAt', 'id', 'text'],
    ['ackRequired', 'createdAt', 'id', 'text'],
  ])
  expect(claimed.warning).toContain('offline for warning proof')
  expect(claimed.warning).toContain('proof Forged-Warning: session-start')
  expect(claimed.warning).not.toContain('\n')
  await markBoardNoticesDelivered(
    claimed.notices.map((row) => row.id),
    env,
  )
  expect((await claimBoardNotices(false, { env })).notices).toEqual([])

  const localRead = postNotice(
    { audience: 'session:delivery-reader', title: 'Local read', body: 'local body' },
    {},
    Date.parse(createdAt) + 1,
  )
  const hostedRead = hosted('session:delivery-reader')
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(hostedRead.id, hostedRead.kind, null, hostedRead.revision, JSON.stringify(hostedRead))
  const read = await readBoardNotices(false, { env })
  expect(read.notices.map((row) => row.id)).toEqual([String(localRead.id), hostedRead.id])
  expect(read.warning).toContain('offline for warning proof')
  expect(read.warning).not.toContain('\n')
  expect((await readBoardNotices(false, { env })).notices).toEqual([])
})

test('a second chain turn claims and marks hosted and local notices through its root reader', async () => {
  const recordId = newRecordId()
  const root = db()
    .query(
      `INSERT INTO run(started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,launch_key,record_id,turn)
       VALUES (?,'codex','implement','delivery-project','sha',1,'prompt','running','DEV-968',?,1) RETURNING id`,
    )
    .get('2026-10-05T11:00:00.000Z', recordId) as { id: number }
  const turn = db()
    .query(
      `INSERT INTO run(started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,launch_key,parent_run_id,turn)
       VALUES (?,'codex','implement','delivery-project','sha',1,'prompt','running','DEV-968',?,2) RETURNING id`,
    )
    .get('2026-10-05T11:30:00.000Z', root.id) as { id: number }
  const local = postNotice(
    { audience: `run:${root.id}`, title: 'Local chain', body: 'local body' },
    {},
    Date.parse(createdAt),
  )
  const remote = hosted(`run:${recordId}`)
  installFailedRefreshWithCached(remote)
  const delivery = await claimRunBoardNotices(turn.id)
  expect(delivery.notices.map((row) => row.id)).toEqual([String(local.id), remote.id])
  expect(delivery.warning).toContain('offline for warning proof')
  await markRunBoardNoticesDelivered(
    turn.id,
    delivery.notices.map((row) => row.id),
  )
  expect((await claimRunBoardNotices(turn.id)).notices).toEqual([])
  expect(
    db()
      .query('SELECT reader_session FROM hosted_board_receipt_cache WHERE message_id=?')
      .get(remote.id),
  ).toEqual({ reader_session: `run:${root.id}` })
})
