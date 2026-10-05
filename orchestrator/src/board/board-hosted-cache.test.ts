import { beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import type { HostedBoardChange, HostedBoardMessage } from '../record/record-board-contract.ts'
import {
  BOARD_REFRESH_CURSOR_KEY,
  BOARD_REFRESH_OUTCOME_KEY,
  cachedMessageAddressed,
  claimCachedHosted,
  hostedBoardVerificationWarning,
  markCachedHostedDelivered,
  refreshHostedBoard,
  takeHostedBoardVerificationTransition,
} from './board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'

const userId = '01990000-0000-7000-8000-000000000001'
const createdAt = '2026-10-05T12:00:00.000Z'

const message = (overrides: Partial<HostedBoardMessage> = {}): HostedBoardMessage => ({
  id: newRecordId(),
  kind: 'notice',
  threadRootId: null,
  title: 'Hosted cache',
  body: 'cached body',
  audience: 'session:cache-reader',
  origin: {
    kind: 'architect',
    session: 'author',
    harness: 'claude',
    project: 'cache-project',
    runId: null,
  },
  senderTags: [],
  createdAt,
  expiresAt: '2027-10-05T12:00:00.000Z',
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
  authorUserId: userId,
  authorSession: 'author',
  ackRequired: false,
  ackDeadline: null,
  ...overrides,
})

const change = (value: HostedBoardMessage): HostedBoardChange => ({
  message: value,
  tags: [],
  receipts: [],
})

beforeEach(() => {
  db().query('DELETE FROM hosted_board_receipt_cache').run()
  db().query('DELETE FROM hosted_board_message_tag_cache').run()
  db().query('DELETE FROM hosted_board_message_cache').run()
  db().query("DELETE FROM schema_meta WHERE key LIKE 'board_hosted_%'").run()
  db().query("DELETE FROM presence WHERE session_id='cache-reader'").run()
})

test('an unadopted refresh touches neither the hosted client nor the cache', async () => {
  let calls = 0
  const client = {
    ...createMemoryRecordApiClient(),
    whoami: async () => {
      calls++
      throw new Error('must not call')
    },
  }
  expect(
    await refreshHostedBoard({
      budgetMs: 50,
      env: { ORCH_RECORD_API_URL: 'https://record.test' },
      client,
    }),
  ).toBe('local')
  expect(calls).toBe(0)
  expect(
    (db().query('SELECT COUNT(*) count FROM hosted_board_message_cache').get() as { count: number })
      .count,
  ).toBe(0)
})

test('refresh pages to completion, advances with each page, and replaces an updated row', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const first = message()
  const filler = Array.from({ length: 99 }, () => change(message()))
  const calls: string[] = []
  const client = {
    ...createMemoryRecordApiClient(),
    listBoardChanges: async ({ after }: { after?: string }) => {
      calls.push(after ?? '0')
      if (after === '0') return { items: [change(first), ...filler], highestRevision: '100' }
      return {
        items: [change({ ...first, body: 'updated', revision: '101' })],
        highestRevision: '101',
      }
    },
    putBoardReceipt: async () => {
      throw new Error('unused')
    },
  }
  expect(
    await refreshHostedBoard({ budgetMs: 1_000, env: { ORCH_RECORD_API_URL: 'x' }, client }),
  ).toBe('success')
  expect(calls).toEqual(['0', '100'])
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_REFRESH_CURSOR_KEY),
  ).toEqual({ value: '101' })
  expect(
    (
      JSON.parse(
        (
          db().query('SELECT payload FROM hosted_board_message_cache WHERE id=?').get(first.id) as {
            payload: string
          }
        ).payload,
      ) as HostedBoardMessage
    ).body,
  ).toBe('updated')
})

test('refresh records an unreachable service without throwing and exposes verification failure', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
     VALUES ('cache-reader','claude','architect','machine','cache-project','/tmp',NULL,?,?)`,
    )
    .run(createdAt, createdAt)
  const cached = message()
  const good = {
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => ({ items: [change(cached)], highestRevision: '1' }),
    putBoardReceipt: async () => {
      throw new Error('unused')
    },
  }
  await refreshHostedBoard({ budgetMs: 1_000, env: { ORCH_RECORD_API_URL: 'x' }, client: good })
  const failed = {
    ...good,
    whoami: async () => {
      throw new Error('offline')
    },
  }
  expect(
    await refreshHostedBoard({
      budgetMs: 1_000,
      env: { ORCH_RECORD_API_URL: 'x' },
      client: failed,
    }),
  ).toBe('failed')
  expect(
    (
      db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_REFRESH_OUTCOME_KEY) as {
        value: string
      }
    ).value,
  ).toContain('offline')
  expect(hostedBoardVerificationWarning()).toContain('Hosted board cache is unverified')
  expect(hostedBoardVerificationWarning()).toContain('offline')
  expect(
    claimCachedHosted('cache-reader', false, Date.parse('2026-10-05T12:02:00.000Z')),
  ).toHaveLength(1)
  expect(takeHostedBoardVerificationTransition()).toContain('unverified')
  expect(takeHostedBoardVerificationTransition()).toBeNull()
  await refreshHostedBoard({ budgetMs: 1_000, env: { ORCH_RECORD_API_URL: 'x' }, client: good })
  expect(takeHostedBoardVerificationTransition()).toContain('verified again')
  expect(takeHostedBoardVerificationTransition()).toBeNull()
})

test('routing narrows own-user audiences and withholds questions from worker chains', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
     VALUES ('cache-reader','claude','architect','machine','cache-project','/tmp','DEV-968',?,?)`,
    )
    .run(createdAt, '2026-10-05T12:01:00.000Z')
  const own = message({ audience: 'architects' })
  const other = message({ audience: 'architects', authorUserId: newRecordId() })
  const client = {
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => ({ items: [change(own), change(other)], highestRevision: '2' }),
    putBoardReceipt: async () => {
      throw new Error('unused')
    },
  }
  await refreshHostedBoard({ budgetMs: 1_000, env: { ORCH_RECORD_API_URL: 'x' }, client })
  expect(
    claimCachedHosted('cache-reader', false, Date.parse('2026-10-05T12:02:00.000Z')).map(
      (row) => row.id,
    ),
  ).toEqual([own.id])
  expect(
    cachedMessageAddressed(
      {
        message: message({
          kind: 'question',
          audience: 'run:01990000-0000-7000-8000-000000000099',
        }),
        tags: [],
      },
      'run:999',
      Date.parse(createdAt),
      db(),
    ),
  ).toBe(false)
})

test('a local delivery stamp suppresses a repeat and its failed hosted write retries on refresh', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
     VALUES ('cache-reader','claude','architect','machine','cache-project','/tmp',NULL,?,?)`,
    )
    .run('2026-10-05T11:00:00.000Z', createdAt)
  const cached = message()
  const base = {
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => ({ items: [change(cached)], highestRevision: '1' }),
  }
  await refreshHostedBoard({
    budgetMs: 1_000,
    env: { ORCH_RECORD_API_URL: 'x' },
    client: {
      ...base,
      putBoardReceipt: async () => {
        throw new Error('unused')
      },
    },
  })
  await markCachedHostedDelivered('cache-reader', [cached.id], {
    client: {
      ...base,
      putBoardReceipt: async () => {
        throw new Error('offline')
      },
    },
  })
  expect(claimCachedHosted('cache-reader')).toEqual([])
  const receipts: boolean[] = []
  const retry = {
    ...base,
    listBoardChanges: async () => ({ items: [], highestRevision: null }),
    putBoardReceipt: async (input: { audienceAtPosting: boolean }) => {
      receipts.push(input.audienceAtPosting)
      return {} as never
    },
  }
  await refreshHostedBoard({ budgetMs: 1_000, env: { ORCH_RECORD_API_URL: 'x' }, client: retry })
  expect(receipts).toEqual([true])
})
