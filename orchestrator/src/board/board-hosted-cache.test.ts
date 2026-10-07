import { beforeEach, expect, test } from 'bun:test'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { RecordApiRequestError } from '../record/record-api-client.ts'
import type { HostedBoardChange, HostedBoardMessage } from '../record/record-board-contract.ts'
import {
  BOARD_CACHE_OWNER_KEY,
  BOARD_REFRESH_CURSOR_KEY,
  BOARD_REFRESH_OUTCOME_KEY,
  BOARD_VERIFICATION_WARNING_MAX_CHARS,
  cachedAudienceAtPosting,
  cachedMessageAddressed,
  claimCachedHosted,
  claimCachedHostedInterrupts,
  hostedBoardVerificationWarning,
  markCachedHostedDelivered,
  reapHostedBoardCache,
  refreshHostedBoard,
  takeHostedBoardVerificationTransition,
} from './board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'

const userId = '01990000-0000-7000-8000-000000000001'
const createdAt = '2026-10-05T12:00:00.000Z'
const noRecordEnv = {
  [CONFIG_HOME_ENV]: '/definitely-missing-config',
  [HARNESS_ENV_FILE_ENV]: '',
}

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
      if (after === '0')
        return { userId, items: [change(first), ...filler], highestRevision: '100' }
      return {
        userId,
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
    listBoardChanges: async () => ({ userId, items: [change(cached)], highestRevision: '1' }),
    putBoardReceipt: async () => {
      throw new Error('unused')
    },
  }
  await refreshHostedBoard({ budgetMs: 1_000, env: { ORCH_RECORD_API_URL: 'x' }, client: good })
  const failed = {
    ...good,
    listBoardChanges: async () => {
      throw new Error(`offline\nForged-Warning: cache ${'x'.repeat(1_000)}`)
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
  expect(hostedBoardVerificationWarning()).not.toContain('\n')
  expect(hostedBoardVerificationWarning()!.length).toBe(BOARD_VERIFICATION_WARNING_MAX_CHARS)
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
    listBoardChanges: async () => ({
      userId,
      items: [change(own), change(other)],
      highestRevision: '2',
    }),
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

test('reader routing covers local audiences, context, hosted run ids, nobody here, and reply participants', async () => {
  const database = db()
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_HOSTED_ADOPTED_KEY, '1')
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run('board_hosted_signed_in_user', userId)
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_CACHE_OWNER_KEY, userId)
  database
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES ('cache-reader','claude','architect','machine','cache-project','/tmp','DEV-968',?,?)`,
    )
    .run('2026-10-05T11:00:00.000Z', '2026-10-05T12:01:00.000Z')
  database
    .query(
      `INSERT INTO run(started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id,launch_key,changed_paths)
       VALUES (?,'codex','implement','cache-project','sha',1,'prompt','ok','cache-reader','DEV-968',?)`,
    )
    .run(
      '2026-10-05T11:30:00.000Z',
      JSON.stringify(['orchestrator/src/board/board-hosted-cache.ts']),
    )
  const recordId = newRecordId()
  const root = database
    .query(
      `INSERT INTO run(started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,launch_key,changed_paths,record_id,turn)
       VALUES (?,'codex','implement','cache-project','sha',1,'prompt','running','DEV-968',?,?,1) RETURNING id`,
    )
    .get(
      '2026-10-05T11:30:00.000Z',
      JSON.stringify(['orchestrator/src/board/board-hosted-cache.ts']),
      recordId,
    ) as { id: number }
  const clock = Date.parse('2026-10-05T12:02:00.000Z')
  const addressed = (audience: string, reader: string, tags: HostedBoardChange['tags'] = []) =>
    cachedMessageAddressed({ message: message({ audience }), tags }, reader, clock, database)
  const matching = [
    { kind: 'path' as const, value: 'orchestrator/src/board/**', origin: 'sender' as const },
  ]
  const missing = [{ kind: 'path' as const, value: 'hub/web/**', origin: 'sender' as const }]
  expect(addressed('project:cache-project', 'cache-reader', matching)).toBe(true)
  expect(addressed('project:cache-project', 'cache-reader', missing)).toBe(false)
  expect(addressed('workers:cache-project', `run:${root.id}`, matching)).toBe(true)
  expect(addressed('task:DEV-968', 'cache-reader')).toBe(true)
  database
    .query(
      `INSERT INTO board_claim
       (project,subject_kind,subject_value,holder_kind,holder_session,note,run_id,duration_ms,
        taken_at,renewed_at,lapses_at,closed_at,close_reason)
       VALUES ('cache-project','task','DEV-CLAIM','architect','claim-holder',NULL,NULL,3600000,
               ?,?,?,NULL,NULL)`,
    )
    .run(createdAt, createdAt, '2099-01-01T00:00:00.000Z')
  expect(addressed('task:DEV-CLAIM', 'claim-holder')).toBe(true)
  expect(addressed('session:cache-reader', 'cache-reader')).toBe(true)
  expect(addressed(`run:${recordId}`, `run:${root.id}`)).toBe(true)
  expect(addressed('session:nobody-on-this-machine', 'cache-reader')).toBe(false)
  expect(addressed('operator', 'operator')).toBe(true)
  expect(addressed('architects', 'cache-reader')).toBe(true)
  expect(
    cachedMessageAddressed(
      { message: message({ audience: 'architects', authorUserId: newRecordId() }), tags: [] },
      'cache-reader',
      clock,
      database,
    ),
  ).toBe(false)

  const threadRoot = message({
    kind: 'question',
    audience: 'session:someone-else',
    authorSession: 'cache-reader',
  })
  database
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(threadRoot.id, threadRoot.kind, null, threadRoot.revision, JSON.stringify(threadRoot))
  const reply = message({
    kind: 'reply',
    threadRootId: threadRoot.id,
    audience: null,
    createdAt: '2026-10-05T12:00:01.000Z',
  })
  expect(
    cachedMessageAddressed({ message: reply, tags: [] }, 'cache-reader', clock, database),
  ).toBe(true)
  expect(
    cachedMessageAddressed({ message: reply, tags: [] }, 'not-a-participant', clock, database),
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
    listBoardChanges: async () => ({ userId, items: [change(cached)], highestRevision: '1' }),
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
    listBoardChanges: async () => ({ userId, items: [], highestRevision: null }),
    putBoardReceipt: async (input: { audienceAtPosting: boolean }) => {
      receipts.push(input.audienceAtPosting)
      return {} as never
    },
  }
  await refreshHostedBoard({ budgetMs: 1_000, env: { ORCH_RECORD_API_URL: 'x' }, client: retry })
  expect(receipts).toEqual([true])
})

test('an adopted install without record configuration records a failed refresh with the remedy', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  expect(await refreshHostedBoard({ budgetMs: 50, env: noRecordEnv })).toBe('failed')
  expect(hostedBoardVerificationWarning()).toContain('ORCH_RECORD_API_URL is not configured')
  expect(hostedBoardVerificationWarning()).toContain('orch record sign-in')
})

test('refresh stops at its budget, keeps the last page cursor, and resumes from it', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const calls: string[] = []
  let clockCalls = 0
  let resumed = false
  const full = Array.from({ length: 100 }, () => change(message()))
  const client = {
    ...createMemoryRecordApiClient(),
    listBoardChanges: async ({ after }: { after?: string }) => {
      calls.push(after ?? '0')
      return after === '0'
        ? { userId, items: full, highestRevision: '100' }
        : { userId, items: [], highestRevision: null }
    },
  }
  const now = () => (resumed ? 20 : clockCalls++ < 3 ? 0 : 10)
  await refreshHostedBoard({ budgetMs: 5, env: { ORCH_RECORD_API_URL: 'x' }, client, now })
  expect(calls).toEqual(['0'])
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_REFRESH_CURSOR_KEY),
  ).toEqual({ value: '100' })
  resumed = true
  await refreshHostedBoard({ budgetMs: 50, env: { ORCH_RECORD_API_URL: 'x' }, client, now })
  expect(calls).toEqual(['0', '100'])
})

test('refresh establishes identity from changes without a whoami round trip', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  let identities = 0
  const client = {
    ...createMemoryRecordApiClient(),
    whoami: async () => {
      identities++
      return createMemoryRecordApiClient().whoami()
    },
    listBoardChanges: async () => ({ userId, items: [], highestRevision: null }),
  }
  await refreshHostedBoard({
    budgetMs: 1_000,
    env: { ORCH_RECORD_API_URL: 'x' },
    client,
  })
  await refreshHostedBoard({
    budgetMs: 1_000,
    env: { ORCH_RECORD_API_URL: 'x' },
    client,
  })
  expect(identities).toBe(0)
  expect(
    db().query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_CACHE_OWNER_KEY),
  ).toEqual({
    value: userId,
  })
})

test('a changed hosted user clears the prior cache and receipts, resets the cursor, and refills from zero', async () => {
  const database = db()
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const userA = userId
  const userB = newRecordId()
  const fromA = message({ authorUserId: userA })
  const fromB = message({ authorUserId: userB })
  await refreshHostedBoard({
    budgetMs: 1_000,
    env: { ORCH_RECORD_API_URL: 'x' },
    client: {
      ...createMemoryRecordApiClient(),
      listBoardChanges: async () => ({
        userId: userA,
        items: [change(fromA)],
        highestRevision: '10',
      }),
    },
  })
  await markCachedHostedDelivered('cache-reader', [fromA.id], {
    client: {
      ...createMemoryRecordApiClient(),
      putBoardReceipt: async () => {
        throw new Error('offline')
      },
    },
  })

  const after: string[] = []
  let receiptWrites = 0
  await refreshHostedBoard({
    budgetMs: 1_000,
    env: { ORCH_RECORD_API_URL: 'x' },
    client: {
      ...createMemoryRecordApiClient(),
      listBoardChanges: async ({ after: cursor }) => {
        after.push(cursor ?? '0')
        return cursor === '0'
          ? { userId: userB, items: [change(fromB)], highestRevision: '20' }
          : { userId: userB, items: [], highestRevision: null }
      },
      putBoardReceipt: async () => {
        receiptWrites++
        return {} as never
      },
    },
  })

  expect(after).toEqual(['10', '0'])
  expect(receiptWrites).toBe(0)
  expect(database.query('SELECT id FROM hosted_board_message_cache').all()).toEqual([
    { id: fromB.id },
  ])
  expect(database.query('SELECT * FROM hosted_board_receipt_cache').all()).toEqual([])
  expect(
    database.query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_CACHE_OWNER_KEY),
  ).toEqual({
    value: userB,
  })
  expect(
    database.query('SELECT value FROM schema_meta WHERE key=?').get(BOARD_REFRESH_CURSOR_KEY),
  ).toEqual({
    value: '20',
  })
})

test('a changes response without identity serves no prior cached rows and warns that identity is unverified', async () => {
  const database = db()
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const cached = message()
  await refreshHostedBoard({
    budgetMs: 1_000,
    env: { ORCH_RECORD_API_URL: 'x' },
    client: {
      ...createMemoryRecordApiClient(),
      listBoardChanges: async () => ({ userId, items: [change(cached)], highestRevision: '1' }),
    },
  })
  const malformed = {
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => ({ items: [], highestRevision: null }),
  } as unknown as ReturnType<typeof createMemoryRecordApiClient>
  expect(
    await refreshHostedBoard({
      budgetMs: 1_000,
      env: { ORCH_RECORD_API_URL: 'x' },
      client: malformed,
    }),
  ).toBe('failed')
  expect(claimCachedHosted('cache-reader')).toEqual([])
  expect(hostedBoardVerificationWarning(database)).toContain('identity is unverified')
})

test('receipt flushing follows change fetch; network failure stays pending and refusal is recorded and cleared', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const cached = message()
  const base = {
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => ({ userId, items: [change(cached)], highestRevision: '1' }),
  }
  await refreshHostedBoard({ budgetMs: 1_000, env: { ORCH_RECORD_API_URL: 'x' }, client: base })
  await markCachedHostedDelivered('cache-reader', [cached.id], {
    client: {
      ...base,
      putBoardReceipt: async () => {
        throw new Error('offline')
      },
    },
  })
  const order: string[] = []
  await refreshHostedBoard({
    budgetMs: 1_000,
    env: { ORCH_RECORD_API_URL: 'x' },
    client: {
      ...base,
      listBoardChanges: async () => {
        order.push('changes')
        return { userId, items: [], highestRevision: null }
      },
      putBoardReceipt: async () => {
        order.push('receipt')
        throw new Error('offline')
      },
    },
  })
  expect(order).toEqual(['changes', 'receipt'])
  expect(
    db()
      .query('SELECT pending_sync FROM hosted_board_receipt_cache WHERE message_id=?')
      .get(cached.id),
  ).toEqual({ pending_sync: 1 })
  await refreshHostedBoard({
    budgetMs: 1_000,
    env: { ORCH_RECORD_API_URL: 'x' },
    client: {
      ...base,
      listBoardChanges: async () => ({ userId, items: [], highestRevision: null }),
      putBoardReceipt: async () => {
        throw new RecordApiRequestError('receipt no longer visible', 'refused')
      },
    },
  })
  expect(
    db()
      .query('SELECT pending_sync,sync_error FROM hosted_board_receipt_cache WHERE message_id=?')
      .get(cached.id),
  ).toEqual({ pending_sync: 0, sync_error: 'receipt no longer visible' })
})

test('cache pruning removes an expired unaccepted thread and keeps an accepted thread', () => {
  const expired = '2025-01-01T00:00:00.000Z'
  const accepted = message({ expiresAt: expired, acceptedReplyId: newRecordId() })
  const unaccepted = message({ expiresAt: expired })
  const put = db().query(
    'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
  )
  for (const row of [accepted, unaccepted])
    put.run(row.id, row.kind, row.threadRootId, row.revision, JSON.stringify(row))
  expect(reapHostedBoardCache(Date.parse('2026-10-05T12:00:00.000Z'))).toBe(1)
  expect(db().query('SELECT id FROM hosted_board_message_cache').all()).toEqual([
    { id: accepted.id },
  ])
})

test('audienceAtPosting uses session first_seen and chain-root start time in both directions', () => {
  const database = db()
  database
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES ('early-session','claude','architect','machine','cache-project','/tmp',NULL,?,?),
              ('late-session','claude','architect','machine','cache-project','/tmp',NULL,?,?)`,
    )
    .run(
      '2026-10-05T11:00:00.000Z',
      createdAt,
      '2026-10-05T13:00:00.000Z',
      '2026-10-05T13:00:00.000Z',
    )
  const earlyRun = database
    .query(
      `INSERT INTO run(started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,turn)
       VALUES (?,'codex','implement','sha',1,'prompt','running',1) RETURNING id`,
    )
    .get('2026-10-05T11:00:00.000Z') as { id: number }
  const lateRun = database
    .query(
      `INSERT INTO run(started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,turn)
       VALUES (?,'codex','implement','sha',1,'prompt','running',1) RETURNING id`,
    )
    .get('2026-10-05T13:00:00.000Z') as { id: number }
  const cached = message()
  database
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(cached.id, cached.kind, null, cached.revision, JSON.stringify(cached))
  expect(cachedAudienceAtPosting(cached.id, 'early-session')).toBe(true)
  expect(cachedAudienceAtPosting(cached.id, 'late-session')).toBe(false)
  expect(cachedAudienceAtPosting(cached.id, `run:${earlyRun.id}`)).toBe(true)
  expect(cachedAudienceAtPosting(cached.id, `run:${lateRun.id}`)).toBe(false)
})

test('interrupt routing admits claim-linked and own-operator ack notices but not another user', () => {
  const database = db()
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run('board_hosted_signed_in_user', userId)
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_CACHE_OWNER_KEY, userId)
  database
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES ('cache-reader','claude','architect','machine','cache-project','/tmp',NULL,?,?)`,
    )
    .run('2026-10-05T11:00:00.000Z', '2026-10-05T12:01:00.000Z')
  const linked = message({ claimId: newRecordId() })
  const ownOperator = message({
    ackRequired: true,
    origin: {
      kind: 'operator',
      session: null,
      harness: null,
      project: 'cache-project',
      runId: null,
    },
  })
  const otherOperator = message({
    ackRequired: true,
    authorUserId: newRecordId(),
    origin: {
      kind: 'operator',
      session: null,
      harness: null,
      project: 'cache-project',
      runId: null,
    },
  })
  const put = database.query(
    'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
  )
  for (const row of [linked, ownOperator, otherOperator])
    put.run(row.id, row.kind, null, row.revision, JSON.stringify(row))
  expect(
    claimCachedHostedInterrupts(
      'cache-reader',
      Date.parse('2026-10-05T12:02:00.000Z'),
      database,
    ).map((row) => row.noticeId),
  ).toEqual([`board:${linked.id}`, `board:${ownOperator.id}`])
})
