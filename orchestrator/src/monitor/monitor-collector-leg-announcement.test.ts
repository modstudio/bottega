import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import type { CollectorLegFailure } from './collector-leg-conditions.ts'
import { announceCollectorLegFailures } from './monitor-collector-leg-announcement.ts'

const now = Date.parse('2026-11-22T12:20:00.000Z')
const failure: CollectorLegFailure = {
  source: 'hosted-changes',
  failingSince: '2026-11-22T12:00:00.000Z',
  ageMs: 20 * 60_000,
  lastError: 'record query failed',
}
const destinationResolver = async () => ({ destinationSpaceId: 'platform-space' })
const env = {
  BOTTEGA_RECORD_API_URL: 'https://record.example.test',
  CLAUDE_CODE_SESSION_ID: 'collector-leg-monitor',
}

test('a failing leg posts exactly once to the project architects', async () => {
  const database = migratedTestDatabase()
  const posts: Parameters<RecordApiClient['postBoardMessage']>[0][] = []
  try {
    const result = await announceCollectorLegFailures(database, [failure], now, {
      env,
      destinationResolver,
      boardClient: {
        listBoardMessages: async () => ({ messages: [], truncated: false }),
        postBoardMessage: async (input) => {
          posts.push(input)
          return { id: 'posted' } as Awaited<ReturnType<RecordApiClient['postBoardMessage']>>
        },
        withdrawBoardMessage: async () => {
          throw new Error('unexpected withdrawal')
        },
      },
    })

    expect(result.errors).toEqual([])
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({
      audience: `architects:${PLATFORM_SLUG}`,
      purpose: 'request',
    })
  } finally {
    database.close()
  }
})

test('a board error becomes an observation error instead of escaping the pass', async () => {
  const database = migratedTestDatabase()
  try {
    const result = await announceCollectorLegFailures(database, [failure], now, {
      env,
      destinationResolver,
      boardClient: {
        listBoardMessages: async () => {
          throw new Error('board unavailable')
        },
        postBoardMessage: async () => {
          throw new Error('unexpected post')
        },
        withdrawBoardMessage: async () => {
          throw new Error('unexpected withdrawal')
        },
      },
    })

    expect(result.errors).toEqual(['collector leg announcement failed: Error: board unavailable'])
  } finally {
    database.close()
  }
})

test('an all-clear pass with no prior failure makes no board call', async () => {
  const database = migratedTestDatabase()
  let calls = 0
  const unexpected = async () => {
    calls += 1
    throw new Error('unexpected board call')
  }
  try {
    expect(
      await announceCollectorLegFailures(database, [], now, {
        env,
        boardClient: {
          listBoardMessages: unexpected,
          postBoardMessage: unexpected,
          withdrawBoardMessage: unexpected,
        },
      }),
    ).toEqual({ errors: [] })
    expect(calls).toBe(0)
  } finally {
    database.close()
  }
})
