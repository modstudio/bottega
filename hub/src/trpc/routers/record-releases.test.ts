import { afterEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../../shared/brand.ts'
import type { RecordFetch } from '../../record-client.ts'
import { recordRouter } from './record.ts'

const originalFetch = globalThis.fetch
const originalRecordApiUrl = process.env.HUB_RECORD_API_URL

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalRecordApiUrl === undefined) delete process.env.HUB_RECORD_API_URL
  else process.env.HUB_RECORD_API_URL = originalRecordApiUrl
})

const release = {
  id: '01990000-0000-7000-8000-000000000011',
  rung: 'production',
  candidateCommit: 'candidate-one',
  liveCommitBefore: 'live-before',
  liveCommitAfter: 'candidate-one',
  rollback: false,
  rollbackReason: null,
  actor: 'operator',
  sessionId: 'session-one',
  startedAt: '2026-10-12T12:00:00.000Z',
  finishedAt: '2026-10-12T12:01:00.000Z',
  exitCode: 0,
  liveMatchesCandidate: true,
  warning: null,
}

function caller(fetch: RecordFetch) {
  process.env.HUB_RECORD_API_URL = 'https://record.example.test'
  globalThis.fetch = fetch as typeof globalThis.fetch
  return recordRouter.createCaller({ authorization: 'Bearer token' })
}

describe('hosted project releases procedure', () => {
  const projectId = '01990000-0000-7000-8000-000000001214'
  test('returns the record client history and latest readings together', async () => {
    const urls: string[] = []
    const api = caller(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/v1/releases/latest')) {
        return Response.json({
          items: [{ rung: 'production', lastGood: release, latestAttempt: null }],
        })
      }
      return Response.json({ items: [release], nextCursor: 'next-page' })
    })
    expect(await api.projectReleases({ projectId, limit: 10 })).toEqual({
      history: { items: [release], nextCursor: 'next-page' },
      latest: { items: [{ rung: 'production', lastGood: release, latestAttempt: null }] },
    })
    expect(urls.sort()).toEqual(
      [
        `https://record.example.test/v1/releases?projectId=${projectId}&limit=10`,
        `https://record.example.test/v1/releases/latest?projectId=${projectId}`,
      ].sort(),
    )
  })

  test('surfaces a record failure instead of returning empty release readings', async () => {
    const api = caller(async () =>
      Response.json(
        {
          error: 'record authentication required',
          remedy: `run \`${PLATFORM_SLUG} record login\``,
        },
        { status: 401 },
      ),
    )
    await expect(api.projectReleases({ projectId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: `run \`${PLATFORM_SLUG} record login\``,
    })
  })
})
