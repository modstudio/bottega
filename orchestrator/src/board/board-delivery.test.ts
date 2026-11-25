import { afterEach, beforeEach, expect, test } from 'bun:test'
import { hostname } from 'node:os'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
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
import { boardAcknowledge, boardPost } from './board-operations.ts'
import { markBoardDeliveryDelivered, pendingBoardDelivery } from './board-push-service.ts'
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
  fixtureProjectRecordId(db())
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
})
afterEach(() => {
  installRecordApiClient(null)
  delete process.env.BOTTEGA_RECORD_API_URL
})

test('a hosted install pushes, delivers, and acknowledges only its local machine notice', async () => {
  const clock = Date.now()
  const session = 'hosted-machine-reader'
  const env = {
    CLAUDE_CODE_SESSION_ID: session,
    BOTTEGA_RECORD_API_URL: 'https://record.test',
  }
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect',?,'delivery-project',(SELECT record_id FROM project WHERE name='delivery-project'),'/tmp',NULL,?,?)`,
    )
    .run(
      session,
      hostname(),
      new Date(clock - 2_000).toISOString(),
      new Date(clock - 1_000).toISOString(),
    )
  const stayedLocal = postNotice(
    { audience: `session:${session}`, title: 'Stayed local', body: 'Do not route locally.' },
    {
      CLAUDE_CODE_SESSION_ID: 'stayed-local-author',
      BOTTEGA_RECORD_API_URL: env.BOTTEGA_RECORD_API_URL,
    },
    clock - 1,
  )
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const posted = await boardPost(
    {
      audience: `machine:${hostname()}`,
      title: 'Machine delivery',
      body: 'Deliver this local machine notice.',
      purpose: 'request',
      ackRequired: true,
    },
    { env: { BOTTEGA_RECORD_API_URL: env.BOTTEGA_RECORD_API_URL }, clock },
  )

  const pending = await pendingBoardDelivery({ session, budgetMs: 0, clock: clock + 1, env })
  expect(pending.delivery.map((notice) => notice.id)).toEqual([String(posted.number)])
  const receipt = () =>
    db()
      .query(
        'SELECT delivered_at,acknowledged_at FROM board_receipt WHERE message_record_id=? AND reader_session=?',
      )
      .get(posted.recordId, session)
  const resetReceipt = () =>
    db()
      .query(
        'UPDATE board_receipt SET delivered_at=NULL,acknowledged_at=NULL WHERE message_record_id=? AND reader_session=?',
      )
      .run(posted.recordId, session)

  await markBoardDeliveryDelivered({
    session,
    ids: pending.delivery.map((notice) => notice.id),
    clock: clock + 2,
    env,
  })
  expect(receipt()).toEqual({
    delivered_at: new Date(clock + 2).toISOString(),
    acknowledged_at: null,
  })

  resetReceipt()
  await markBoardDeliveryDelivered({
    session,
    ids: [posted.recordId],
    clock: clock + 3,
    env,
  })
  expect(receipt()).toEqual({
    delivered_at: new Date(clock + 3).toISOString(),
    acknowledged_at: null,
  })

  resetReceipt()
  await markBoardNoticesDelivered([String(posted.number)], env, { database: db() })
  expect(receipt()).toEqual({ delivered_at: expect.any(String), acknowledged_at: null })

  resetReceipt()
  await markBoardNoticesDelivered([posted.recordId], env, { database: db() })
  expect(receipt()).toEqual({ delivered_at: expect.any(String), acknowledged_at: null })

  await boardAcknowledge(posted.recordId, { env, clock: clock + 4 })
  expect(receipt()).toEqual({
    delivered_at: expect.any(String),
    acknowledged_at: new Date(clock + 4).toISOString(),
  })

  resetReceipt()
  await boardAcknowledge(String(posted.number), { env, clock: clock + 5 })
  expect(receipt()).toEqual({
    delivered_at: new Date(clock + 5).toISOString(),
    acknowledged_at: new Date(clock + 5).toISOString(),
  })

  await expect(
    markBoardDeliveryDelivered({ session, ids: ['not-an-id'], clock: clock + 6, env }),
  ).rejects.toThrow(/board delivery id must be either a positive integer string .* or a UUID/)

  await expect(
    boardAcknowledge(stayedLocal.recordId, {
      env,
      clock: clock + 7,
      client: createMemoryRecordApiClient(),
      destinationResolver: async () => ({ destinationSpaceId: 'space:test' }),
    }),
  ).rejects.toThrow(/hosted board is unused in this fixture/)
  expect(
    db()
      .query(
        'SELECT acknowledged_at FROM board_receipt WHERE message_record_id=? AND reader_session=?',
      )
      .get(stayedLocal.recordId, session),
  ).toEqual({ acknowledged_at: null })
})

test('board read and read --claim use hosted cache instead of differing local rows', async () => {
  const env = {
    CLAUDE_CODE_SESSION_ID: 'delivery-reader',
    BOTTEGA_RECORD_API_URL: 'https://record.test',
  }
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES ('delivery-reader','claude','architect','machine','delivery-project',(SELECT record_id FROM project WHERE name='delivery-project'),'/tmp',NULL,?,?)`,
    )
    .run('2026-10-05T11:00:00.000Z', new Date().toISOString())
  const localClaim = postNotice(
    { audience: 'session:delivery-reader', title: 'Local claim', body: 'local body' },
    {},
    Date.parse(createdAt),
  )
  const hostedClaim = hosted('session:delivery-reader')
  installFailedRefreshWithCached(hostedClaim)
  const refreshed = async () => ({ status: 'success' as const, applied: 0 })
  const claimed = await claimBoardNotices(false, { env, refresh: refreshed })
  expect(claimed.notices.map((row) => row.id)).toEqual([hostedClaim.id])
  expect(String(localClaim.number)).not.toBe(hostedClaim.id)
  await markBoardNoticesDelivered(
    claimed.notices.map((row) => row.id),
    env,
    { refresh: refreshed },
  )
  expect(
    db()
      .query('SELECT delivered_at FROM board_receipt WHERE message_record_id=?')
      .get(localClaim.recordId),
  ).toBeNull()
  expect((await claimBoardNotices(false, { env, refresh: refreshed })).notices).toEqual([])

  const localRead = postNotice(
    { audience: 'session:delivery-reader', title: 'Local read', body: 'local body' },
    env,
    Date.parse(createdAt) + 1,
  )
  const hostedRead = hosted('session:delivery-reader')
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(hostedRead.id, hostedRead.kind, null, hostedRead.revision, JSON.stringify(hostedRead))
  const read = await readBoardNotices(false, { env, refresh: refreshed })
  expect(read.notices.map((row) => row.id)).toEqual([hostedRead.id])
  expect(String(localRead.number)).not.toBe(hostedRead.id)
  expect((await readBoardNotices(false, { env, refresh: refreshed })).notices).toEqual([])
})

test('hand-typed stayed local message refuses before marking on an adopted install', async () => {
  const env = {
    CLAUDE_CODE_SESSION_ID: 'delivery-reader',
    BOTTEGA_RECORD_API_URL: 'https://record.test',
  }
  const local = postNotice(
    { audience: 'session:delivery-reader', title: 'Stayed local', body: 'local body' },
    {},
    Date.parse(createdAt),
  )
  db()
    .query(
      `INSERT INTO board_hosted_adoption_ledger
       (source_record_id,local_kind,state,refusal,created_at,updated_at)
       VALUES (?,'notice','refused','stayed local',?,?)`,
    )
    .run(local.recordId, createdAt, createdAt)
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')

  await expect(
    markBoardNoticesDelivered([local.recordId], env, {
      refresh: async () => ({ status: 'success', applied: 0 }),
    }),
  ).rejects.toThrow(new RegExp(`${local.recordId}.*board thread`))
  expect(
    db()
      .query('SELECT delivered_at FROM board_receipt WHERE message_record_id=?')
      .get(local.recordId),
  ).toBeNull()
})

test('a second chain turn claims and marks hosted and local notices through its root reader', async () => {
  const recordId = newRecordId()
  const root = db()
    .query(
      `INSERT INTO run(number,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,launch_key,record_id,turn,project_record_id)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','delivery-project','sha',1,'prompt','running','DEV-968',?,1,
               (SELECT record_id FROM project ORDER BY name LIMIT 1)) RETURNING record_id AS id`,
    )
    .get('2026-10-05T11:00:00.000Z', recordId) as { id: string }
  const turn = db()
    .query(
      `INSERT INTO run(record_id,number,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,launch_key,parent_run_record_id,turn,project_record_id)
       VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','delivery-project','sha',1,'prompt','running','DEV-968',?,2,
               (SELECT record_id FROM project ORDER BY name LIMIT 1)) RETURNING record_id AS id`,
    )
    .get('2026-10-05T11:30:00.000Z', root.id) as { id: string }
  const local = postNotice(
    { audience: `run:${root.id}`, title: 'Local chain', body: 'local body' },
    {},
    Date.parse(createdAt),
  )
  const remote = hosted(`run:${recordId}`)
  installFailedRefreshWithCached(remote)
  const refreshed = async () => ({ status: 'success' as const, applied: 0 })
  const delivery = await claimRunBoardNotices(turn.id, false, 500, false, refreshed)
  expect(delivery.notices.map((row) => row.id)).toEqual([remote.id])
  expect(String(local.number)).not.toBe(remote.id)
  await markRunBoardNoticesDelivered(
    turn.id,
    delivery.notices.map((row) => row.id),
  )
  expect(
    db()
      .query('SELECT delivered_at FROM board_receipt WHERE message_record_id=?')
      .get(local.recordId),
  ).toEqual({ delivered_at: null })
  expect((await claimRunBoardNotices(turn.id, false, 500, false, refreshed)).notices).toEqual([])
  expect(
    db()
      .query('SELECT reader_session FROM hosted_board_receipt_cache WHERE message_id=?')
      .get(remote.id),
  ).toEqual({ reader_session: `run:${root.id}` })
})

test('an incomplete refresh leaves a run notice claimable for a later turn', async () => {
  const runId = newRecordId()
  db()
    .query(
      `INSERT INTO run(number,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,launch_key,record_id,turn,project_record_id)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','delivery-project','sha',1,'prompt','running','DEV-2608',?,1,
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run('2026-10-05T11:00:00.000Z', runId)
  const notice = hosted(`run:${runId}`)
  installFailedRefreshWithCached(notice)

  const incomplete = await claimRunBoardNotices(runId, false, 500, false, async () => ({
    status: 'incomplete' as const,
    applied: 0,
  }))

  expect(incomplete.notices).toEqual([])
  expect(incomplete.warning).toBe(
    'hosted board read stopped: refresh did not catch up within its budget; notices stay queued for the next successful refresh',
  )
  expect(
    db()
      .query('SELECT delivered_at FROM hosted_board_receipt_cache WHERE message_id=?')
      .get(notice.id),
  ).toBeNull()
  expect(
    (
      await claimRunBoardNotices(runId, false, 500, false, async () => ({
        status: 'success' as const,
        applied: 0,
      }))
    ).notices.map((row) => row.id),
  ).toEqual([notice.id])
})

test('a spent refresh budget stops the hosted read with a remedy', async () => {
  const env = {
    CLAUDE_CODE_SESSION_ID: 'delivery-reader',
    BOTTEGA_RECORD_API_URL: 'https://record.test',
  }
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES ('delivery-reader','claude','architect','machine','delivery-project',(SELECT record_id FROM project WHERE name='delivery-project'),'/tmp',NULL,?,?)`,
    )
    .run('2026-10-05T11:00:00.000Z', new Date().toISOString())
  const hostedClaim = hosted('session:delivery-reader')
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db()
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_CACHE_OWNER_KEY, hostedClaim.authorUserId)
  db()
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run('board_hosted_signed_in_user', hostedClaim.authorUserId)
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(
      hostedClaim.id,
      hostedClaim.kind,
      hostedClaim.threadRootId,
      hostedClaim.revision,
      JSON.stringify(hostedClaim),
    )
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    listBoardChanges: async ({ signal }: { signal?: AbortSignal }) =>
      await new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  })
  await expect(claimBoardNotices(false, { env, budgetMs: 20 })).rejects.toThrow(
    'hosted board read stopped: refresh did not catch up within its budget',
  )
})

test('session start renders information and standing as one line but a request in full', async () => {
  const clock = Date.now()
  const session = 'purpose-start-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude','architect','machine','delivery-project',(SELECT record_id FROM project WHERE name='delivery-project'),'/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1).toISOString(), new Date(clock).toISOString())
  const posts = [
    postNotice(
      { audience: `session:${session}`, title: 'Info', body: 'information body' },
      {},
      clock,
    ),
    postNotice(
      {
        audience: `session:${session}`,
        title: 'Request',
        body: 'request body',
        purpose: 'request',
      },
      {},
      clock + 1,
    ),
    postNotice(
      {
        audience: `session:${session}`,
        title: 'Standing',
        body: 'standing body',
        purpose: 'standing',
      },
      {},
      clock + 2,
    ),
  ]
  const claimed = await claimBoardNotices(false, {
    env: { CLAUDE_CODE_SESSION_ID: session },
  })
  expect(claimed.notices.map((notice) => notice.id)).toEqual(
    posts.map((post) => String(post.number)),
  )
  expect(claimed.notices[0]!.text).toBe(claimed.notices[0]!.oneLine)
  expect(claimed.notices[1]!.text).toContain('request body')
  expect(claimed.notices[2]!.text).toBe(claimed.notices[2]!.oneLine)
})
