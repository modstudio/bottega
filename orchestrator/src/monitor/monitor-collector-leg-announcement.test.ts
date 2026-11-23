import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import {
  RECORD_TUNNEL_DOWN_NOTICE_THRESHOLD_MS,
  STANDING_CONDITION_NOTICE_PREFIX,
  STORE_WRITE_LOCK_HELD_NOTICE_THRESHOLD_MS,
} from './collector-leg-announcement.ts'
import {
  announceStandingConditions,
  announceStoreWriteLockCondition,
  standingConditionHistoryOnset,
} from './monitor-collector-leg-announcement.ts'
import type { MonitorCondition } from './monitor-types.ts'

const env = {
  BOTTEGA_RECORD_API_URL: 'https://record.example.test',
  CLAUDE_CODE_SESSION_ID: 'standing-condition-monitor',
}
const destinationResolver = async () => ({ destinationSpaceId: 'platform-space' })

const condition = (
  kind: string,
  subject = kind,
  since: string | null = null,
  ageMs: number | null = null,
): MonitorCondition => ({
  kind,
  subject,
  since,
  ageMs,
  detail: `${kind} detail`,
  action: `repair ${kind}`,
})

function finishedPass(database: Database, startedAt: string, kinds: readonly string[]): void {
  const invocation = newRecordId()
  database
    .query(
      `INSERT INTO monitor_invocation (record_id,started_at,finished_at,trigger,findings,errors)
       VALUES (?,?,?,'backstop',?,0)`,
    )
    .run(invocation, startedAt, new Date(Date.parse(startedAt) + 1_000).toISOString(), kinds.length)
  for (const kind of kinds)
    database
      .query(
        `INSERT INTO monitor_condition
         (record_id,invocation_record_id,kind,subject,condition_since,age_ms,detail,action)
         VALUES (?,?,?,?,NULL,NULL,'detail','action')`,
      )
      .run(newRecordId(), invocation, kind, kind)
}

function fakeBoard(overrides: Partial<RecordApiClient> = {}): RecordApiClient {
  return {
    listBoardMessages: async () => ({ messages: [], truncated: false }),
    postBoardMessage: async () =>
      ({ id: 'posted' }) as Awaited<ReturnType<RecordApiClient['postBoardMessage']>>,
    withdrawBoardMessage: async () => undefined,
    ...overrides,
  } as RecordApiClient
}

test('two present passes under the threshold post nothing, then persistence posts', async () => {
  const database = migratedTestDatabase()
  const onset = '2026-11-22T12:00:00.000Z'
  const posts: Parameters<RecordApiClient['postBoardMessage']>[0][] = []
  try {
    finishedPass(database, onset, ['record-tunnel-down'])
    finishedPass(database, '2026-11-22T12:02:00.000Z', ['record-tunnel-down'])
    expect(standingConditionHistoryOnset(database, 'record-tunnel-down', onset)).toBe(onset)

    const before = await announceStandingConditions(
      database,
      [condition('record-tunnel-down')],
      Date.parse(onset) + RECORD_TUNNEL_DOWN_NOTICE_THRESHOLD_MS - 1,
      '2026-11-22T12:04:00.000Z',
      {
        env,
        destinationResolver,
        boardClient: fakeBoard({
          postBoardMessage: async (input) => {
            posts.push(input)
            return { id: 'posted' } as Awaited<ReturnType<RecordApiClient['postBoardMessage']>>
          },
        }),
      },
    )
    expect(before.errors).toEqual([])
    expect(posts).toEqual([])

    const result = await announceStandingConditions(
      database,
      [condition('record-tunnel-down')],
      Date.parse(onset) + RECORD_TUNNEL_DOWN_NOTICE_THRESHOLD_MS,
      '2026-11-22T12:05:00.000Z',
      {
        env,
        destinationResolver,
        boardClient: fakeBoard({
          postBoardMessage: async (input) => {
            posts.push(input)
            return { id: 'posted' } as Awaited<ReturnType<RecordApiClient['postBoardMessage']>>
          },
        }),
      },
    )
    expect(result.errors).toEqual([])
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({
      audience: `architects:${PLATFORM_SLUG}`,
      purpose: 'request',
      title: `${STANDING_CONDITION_NOTICE_PREFIX} record-tunnel-down`,
    })
  } finally {
    database.close()
  }
})

test('one finished pass without the kind resets the history onset', () => {
  const database = migratedTestDatabase()
  try {
    finishedPass(database, '2026-11-22T12:00:00.000Z', ['record-tunnel-down'])
    finishedPass(database, '2026-11-22T12:04:00.000Z', [])
    expect(
      standingConditionHistoryOnset(database, 'record-tunnel-down', '2026-11-22T12:08:00.000Z'),
    ).toBe('2026-11-22T12:08:00.000Z')
  } finally {
    database.close()
  }
})

test('a board error becomes an observation error instead of escaping the pass', async () => {
  const database = migratedTestDatabase()
  try {
    const result = await announceStandingConditions(
      database,
      [condition('record-tunnel-down', 'record', '2026-11-22T12:00:00.000Z')],
      Date.parse('2026-11-22T12:10:00.000Z'),
      '2026-11-22T12:10:00.000Z',
      {
        env,
        destinationResolver,
        boardClient: fakeBoard({
          listBoardMessages: async () => {
            throw new Error('board unavailable')
          },
        }),
      },
    )
    expect(result.errors).toEqual([
      'standing condition announcement failed: Error: board unavailable',
    ])
  } finally {
    database.close()
  }
})

test('the store-busy fallback posts past its threshold from the last healthy pass', async () => {
  const database = migratedTestDatabase()
  const healthy = '2026-11-22T12:00:00.000Z'
  const posts: Parameters<RecordApiClient['postBoardMessage']>[0][] = []
  try {
    finishedPass(database, healthy, [])
    await announceStoreWriteLockCondition(
      database,
      condition('store-write-lock-held', 'orchestrator.db'),
      Date.parse(healthy) + 1_000 + STORE_WRITE_LOCK_HELD_NOTICE_THRESHOLD_MS,
      {
        env,
        destinationResolver,
        boardClient: fakeBoard({
          postBoardMessage: async (input) => {
            posts.push(input)
            return { id: 'posted' } as Awaited<ReturnType<RecordApiClient['postBoardMessage']>>
          },
        }),
      },
    )
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({
      audience: `architects:${PLATFORM_SLUG}`,
      title: `${STANDING_CONDITION_NOTICE_PREFIX} store-write-lock-held`,
    })
  } finally {
    database.close()
  }
})

test('the next normal pass withdraws a fallback store-lock notice with one list call', async () => {
  const database = migratedTestDatabase()
  let lists = 0
  const withdrawals: string[] = []
  try {
    await announceStandingConditions(database, [], Date.now(), new Date().toISOString(), {
      env,
      destinationResolver,
      boardClient: fakeBoard({
        listBoardMessages: async () => {
          lists++
          return {
            messages: [
              {
                id: 'store-lock',
                title: `${STANDING_CONDITION_NOTICE_PREFIX} store-write-lock-held`,
              },
            ],
            truncated: false,
          } as Awaited<ReturnType<RecordApiClient['listBoardMessages']>>
        },
        withdrawBoardMessage: async (id) => {
          withdrawals.push(id)
        },
      }),
    })
    expect(lists).toBe(1)
    expect(withdrawals).toEqual(['store-lock'])
  } finally {
    database.close()
  }
})

test('an unlisted ownerless kind never posts', async () => {
  const database = migratedTestDatabase()
  let posts = 0
  try {
    const result = await announceStandingConditions(
      database,
      [condition('orphan-sandbox-dir', 'sandbox', '2026-11-21T00:00:00.000Z')],
      Date.parse('2026-11-22T12:00:00.000Z'),
      '2026-11-22T12:00:00.000Z',
      {
        env,
        destinationResolver,
        boardClient: fakeBoard({
          postBoardMessage: async () => {
            posts++
            return { id: 'posted' } as Awaited<ReturnType<RecordApiClient['postBoardMessage']>>
          },
        }),
      },
    )
    expect(result.errors).toEqual([])
    expect(posts).toBe(0)
  } finally {
    database.close()
  }
})
