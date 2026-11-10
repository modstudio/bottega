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
    .run(projectId, projectName, process.cwd(), '{}')
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

function addPresence(
  database: Database,
  projectId: string,
  session: string,
  firstSeen: number,
  lastSeen: number,
): void {
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
      new Date(firstSeen).toISOString(),
      new Date(lastSeen).toISOString(),
    )
}

async function refresh(database: Database, client: ReturnType<typeof createMemoryRecordApiClient>) {
  const project = database.query('SELECT path FROM project LIMIT 1').get() as { path: string }
  await refreshHostedBoard({
    budgetMs: 1_000,
    env: { BOTTEGA_RECORD_API_URL: 'memory' },
    database,
    client,
    cwd: project.path,
    presenceDestinationResolver: async () => ({ destinationSpaceId: 'project-space' }),
  })
}

test('a live root author prevents a hosted successor election request', async () => {
  const { client, projectId } = fixture()
  const database = machine(projectId, 'candidate')
  addPresence(database, projectId, 'author', Date.now() - 60_000, Date.now())
  await refresh(database, client)
  let calls = 0
  const countingClient = {
    ...client,
    takeBoardSuccessor: async () => {
      calls += 1
      return { elected: true, holder: 'candidate' }
    },
  }

  expect(
    (
      await claimCachedHostedForPush(
        'candidate',
        false,
        Date.now(),
        database,
        true,
        null,
        countingClient,
      )
    ).notices,
  ).toEqual([])
  expect(calls).toBe(0)
})

test('a lost hosted election suppresses another request on the next poll', async () => {
  const { client, projectId } = fixture()
  const database = machine(projectId, 'candidate')
  const authorLastSeen = Date.now() - SESSION_LIVE_MS - 60_000
  addPresence(database, projectId, 'author', authorLastSeen - 60_000, authorLastSeen)
  await refresh(database, client)
  let calls = 0
  const losingClient = {
    ...client,
    takeBoardSuccessor: async () => {
      calls += 1
      return { elected: false, holder: 'other-holder' }
    },
  }

  await claimCachedHostedForPush('candidate', false, Date.now(), database, true, null, losingClient)
  await claimCachedHostedForPush('candidate', false, Date.now(), database, true, null, losingClient)

  expect(calls).toBe(1)
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

test('a hosted successor receipt holder receives the reply without another election request', async () => {
  const { client, projectId, reply } = fixture({ session: 'reader' })
  const database = machine(projectId, 'reader')
  await refresh(database, client)
  let calls = 0
  const countingClient = {
    ...client,
    takeBoardSuccessor: async () => {
      calls += 1
      return { elected: false, holder: 'reader' }
    },
  }

  expect(
    (
      await claimCachedHostedForPush(
        'reader',
        false,
        Date.now(),
        database,
        true,
        null,
        countingClient,
      )
    ).notices,
  ).toEqual([expect.objectContaining({ id: reply.id, reportReplySuccessor: true })])
  expect(calls).toBe(0)
})

test('a demoted former holder clears its local successor bit and cannot offer the reply', async () => {
  const { client, projectId, reply } = fixture({ session: 'old-holder' })
  const old = machine(projectId, 'old-holder', Date.now() - SESSION_LIVE_MS - 1)
  const next = machine(projectId, 'new-holder')
  await refresh(old, client)
  await refresh(next, client)
  expect(
    await client.takeBoardSuccessor({ messageId: reply.id, candidateSession: 'new-holder' }),
  ).toEqual(expect.objectContaining({ holder: 'new-holder' }))
  await refresh(old, client)
  expect(
    old
      .query(
        'SELECT successor FROM hosted_board_receipt_cache WHERE message_id=? AND reader_session=?',
      )
      .get(reply.id, 'old-holder'),
  ).toEqual({ successor: 0 })
  expect(claimCachedHosted('old-holder', false, Date.now(), old)).toEqual([])
})
