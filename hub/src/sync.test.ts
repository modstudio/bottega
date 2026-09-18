import { describe, expect, test } from 'bun:test'
import { evidenceApi } from './evidence-api.ts'
import { batches, contentHash, diffRows, signedInRecordUserId, syncEvidence } from './sync.ts'

describe('evidence sync planning', () => {
  test('captures the signed-in record user and keeps an absent session null', async () => {
    expect(
      await signedInRecordUserId({
        baseUrl: 'https://record.example.test',
        token: 'session',
        fetch: async () => Response.json({ user: { id: 'user-42' } }),
      }),
    ).toBe('user-42')
    expect(
      await signedInRecordUserId({ baseUrl: 'https://record.example.test', token: null }),
    ).toBeNull()
  })

  test('hashes stable content deterministically', () => {
    const row = { source: 'orch', ref: 'orch:1', start_at: '2026-09-17T00:00:00.000Z' }
    expect(contentHash(row)).toBe(contentHash({ ...row }))
    expect(contentHash({ ...row, ref: 'orch:2' })).not.toBe(contentHash(row))
  })

  test('selects new and changed rows and vanished keys', () => {
    const unchanged = { day: '2026-09-16', commits: 2 }
    const changed = { day: '2026-09-17', commits: 3 }
    const plan = diffRows(
      [
        { key: unchanged.day, row: unchanged },
        { key: changed.day, row: changed },
      ],
      [
        { local_key: unchanged.day, content_hash: contentHash(unchanged) },
        { local_key: changed.day, content_hash: contentHash({ ...changed, commits: 1 }) },
        { local_key: '2026-09-15', content_hash: 'old' },
      ],
    )
    expect(plan.changed.map((row) => row.key)).toEqual(['2026-09-17'])
    expect(plan.deleted).toEqual(['2026-09-15'])
  })

  test('refuses to infer deletes from an empty local table', () => {
    const plan = diffRows([], [{ local_key: 'existing', content_hash: 'old' }])
    expect(plan.deleted).toEqual([])
    expect(plan.deleteSkipped).toBe(true)
  })

  test('splits writes at the hosted batch limit', () => {
    expect(
      batches(Array.from({ length: 1_001 }, (_, index) => index)).map((x) => x.length),
    ).toEqual([500, 500, 1])
  })
})

describe('evidence API', () => {
  test('refuses a route without authorization before touching identity or storage', async () => {
    let fetched = false
    const response = await evidenceApi(
      new Request('https://hub.example.test/v1/evidence/intervals', { method: 'PUT' }),
      { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://record' },
      {
        fetch: async () => {
          fetched = true
          return Response.json({})
        },
      },
    )
    expect(response?.status).toBe(401)
    expect(fetched).toBe(false)
  })

  test('refuses real hosted clients under the test preload', async () => {
    await expect(
      evidenceApi(
        new Request('https://hub.example.test/v1/evidence/intervals', {
          method: 'PUT',
          headers: { authorization: 'Bearer fixture' },
        }),
        { recordApiUrl: 'https://record.example.test', recordDatabaseUrl: 'postgres://record' },
      ),
    ).rejects.toThrow('refuses real identity and database clients')
    await expect(
      syncEvidence({ baseUrl: 'https://hub.example.test', token: 'fixture' }),
    ).rejects.toThrow('refuses a real hosted URL')
  })
})
