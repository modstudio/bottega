import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { HostedBoardChange, HostedBoardMessage } from '../record/record-board-contract.ts'
import {
  claimCachedHosted,
  claimCachedHostedForPush,
  refreshHostedBoard,
} from './board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'

const projectName = PLATFORM_SLUG

function hostedMessage(overrides: Partial<HostedBoardMessage>): HostedBoardMessage {
  return {
    id: newRecordId(),
    kind: 'notice',
    threadRootId: null,
    title: 'Report',
    body: 'body',
    audience: null,
    origin: {
      kind: 'architect',
      session: 'author',
      harness: 'claude',
      project: projectName,
      projectStored: true,
      runId: null,
    },
    senderTags: [],
    createdAt: new Date(Date.now() - SESSION_LIVE_MS - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + SESSION_LIVE_MS).toISOString(),
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
    authorUserId: 'user-a',
    authorSession: 'author',
    ackRequired: false,
    ackDeadline: null,
    ...overrides,
  }
}

function fixture(holder?: { session: string; delivered?: boolean }) {
  const projectId = newRecordId()
  const root = hostedMessage({ revision: '1' })
  const reply = hostedMessage({
    kind: 'reply',
    threadRootId: root.id,
    authorSession: 'replier',
    createdAt: new Date(Date.now() - 30_000).toISOString(),
    revision: '2',
  })
  const changes: HostedBoardChange[] = [
    { message: root, tags: [], receipts: [] },
    {
      message: reply,
      tags: [],
      receipts: holder
        ? [
            {
              messageId: reply.id,
              readerUserId: 'user-a',
              readerSession: holder.session,
              audienceAtPosting: false,
              deliveredAt: holder.delivered ? new Date().toISOString() : null,
              acknowledgedAt: null,
              successor: true,
            },
          ]
        : [],
    },
  ]
  return {
    projectId,
    reply,
    client: createMemoryRecordApiClient({
      boardChanges: changes,
      boardProjectIds: { [projectName]: projectId },
    }),
  }
}

function machine(projectId: string, session: string, lastSeen = Date.now()): Database {
  const database = migratedTestDatabase()
  database
    .query('INSERT INTO project(record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(projectId, projectName, `/tmp/${projectId}`, '{}')
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_HOSTED_ADOPTED_KEY, '1')
  database
    .query(
      `INSERT INTO presence
     (session_id,harness,role,machine,project,project_record_id,cwd,first_seen,last_seen)
     VALUES (?,'codex','architect','machine',?,?,'/tmp',?,?)`,
    )
    .run(
      session,
      projectName,
      projectId,
      new Date(lastSeen - 60_000).toISOString(),
      new Date(lastSeen).toISOString(),
    )
  return database
}

async function refresh(database: Database, client: ReturnType<typeof createMemoryRecordApiClient>) {
  await refreshHostedBoard({
    budgetMs: 1_000,
    env: { BOTTEGA_RECORD_API_URL: 'memory' },
    database,
    client,
  })
}

test('two machine caches sharing one memory record elect exactly one successor', async () => {
  const { client, projectId, reply } = fixture()
  const one = machine(projectId, 'candidate-one')
  const two = machine(projectId, 'candidate-two')
  await refresh(one, client)
  await refresh(two, client)
  const results = await Promise.all([
    claimCachedHostedForPush('candidate-one', false, Date.now(), one, true, null, client),
    claimCachedHostedForPush('candidate-two', false, Date.now(), two, true, null, client),
  ])
  expect(results.flatMap((result) => result.notices.map((notice) => notice.id))).toEqual([reply.id])
})

test('the read path offers a reply only to the hosted successor receipt holder', async () => {
  const without = fixture()
  const reader = machine(without.projectId, 'reader')
  await refresh(reader, without.client)
  expect(claimCachedHosted('reader', false, Date.now(), reader)).toEqual([])

  const withReceipt = fixture({ session: 'reader' })
  const holder = machine(withReceipt.projectId, 'reader')
  await refresh(holder, withReceipt.client)
  expect(claimCachedHosted('reader', false, Date.now(), holder)).toEqual([
    expect.objectContaining({ id: withReceipt.reply.id, reportReplySuccessor: true }),
  ])
})

test('a revived former holder clears its local successor bit and cannot offer the reply', async () => {
  const { client, projectId, reply } = fixture({ session: 'old-holder' })
  const old = machine(projectId, 'old-holder', Date.now() - SESSION_LIVE_MS - 1)
  const next = machine(projectId, 'new-holder')
  await refresh(old, client)
  await refresh(next, client)
  expect(
    (await claimCachedHostedForPush('new-holder', false, Date.now(), next, true, null, client))
      .notices,
  ).toHaveLength(1)
  await refresh(old, client)
  expect(
    old
      .query(
        'SELECT successor FROM hosted_board_receipt_cache WHERE message_id=? AND reader_session=?',
      )
      .get(reply.id, 'old-holder'),
  ).toEqual({ successor: 0 })
  expect(
    (await claimCachedHostedForPush('old-holder', false, Date.now(), old, true, null, client))
      .notices,
  ).toEqual([])
})
