import { describe, expect, test } from 'bun:test'
import { identity } from '../../test/fixtures/record-api.ts'
import { recordApi } from './record-api.ts'

function appWith(session: typeof identity | null, overrides: Record<string, unknown> = {}) {
  const deps = {
    recordUrl: 'postgres://record.test/record',
    auth: { handler: () => Response.json({ handled: true }) },
    readSession: async () => session,
    setActiveSpace: async () => undefined,
    readHealth: async () => ({ ok: true, migrations: 14 }),
    readCommit: () => undefined,
    readReleases: async () => [],
    readLatestReleases: async () => [],
    ...overrides,
  } as unknown as Parameters<typeof recordApi>[0]
  return recordApi(deps)
}

const first = {
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
const second = {
  ...first,
  id: '01990000-0000-7000-8000-000000000010',
  candidateCommit: 'candidate-two',
  startedAt: '2026-10-11T12:00:00.000Z',
}

describe('record release API', () => {
  test('returns every release field newest first and pages with the release cursor', async () => {
    const calls: Array<{ project: string; before: { at: string; id: string } | null }> = []
    const app = appWith(identity, {
      readReleases: async (input: {
        project: string
        before: { at: string; id: string } | null
      }) => {
        calls.push({ project: input.project, before: input.before })
        return input.before ? [second] : [first, second]
      },
    })
    const page = await app.request('/v1/releases?project=bottega&limit=1')
    expect(page.status).toBe(200)
    const body = (await page.json()) as { items: unknown[]; nextCursor: string }
    expect(body.items).toEqual([first])
    expect(body.nextCursor).toBeString()
    const next = await app.request(
      `/v1/releases?project=bottega&limit=1&before=${encodeURIComponent(body.nextCursor)}`,
    )
    expect(await next.json()).toEqual({ items: [second], nextCursor: null })
    expect(calls).toEqual([
      { project: 'bottega', before: null },
      { project: 'bottega', before: { at: first.startedAt, id: first.id } },
    ])
  })

  test('returns not found when the tenant-bound reader cannot see the project', async () => {
    const app = appWith(identity, { readReleases: async () => null })
    const response = await app.request('/v1/releases?project=unknown')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'project not found' })
  })

  test('returns the latest release reading and refuses a missing session', async () => {
    const latest = [{ rung: 'production', lastGood: first, latestAttempt: null }]
    const app = appWith(identity, { readLatestReleases: async () => latest })
    expect(await (await app.request('/v1/releases/latest?project=bottega')).json()).toEqual({
      items: latest,
    })
    const refused = await appWith(null).request('/v1/releases?project=bottega')
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ error: 'record authentication required' })
  })
})
