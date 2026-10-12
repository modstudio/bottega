import { describe, expect, test } from 'bun:test'
import { identity } from '../../test/fixtures/record-api.ts'
import { recordApi } from './record-api.ts'
import { RecordReleaseSpaceRequiredError } from './record-release-reading.ts'

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
    const page = await app.request('/v1/releases?project=project-one&limit=1')
    expect(page.status).toBe(200)
    const body = (await page.json()) as { items: unknown[]; nextCursor: string }
    expect(body.items).toEqual([first])
    expect(body.nextCursor).toBeString()
    const next = await app.request(
      `/v1/releases?project=project-one&limit=1&before=${encodeURIComponent(body.nextCursor)}`,
    )
    expect(await next.json()).toEqual({ items: [second], nextCursor: null })
    expect(calls).toEqual([
      { project: 'project-one', before: null },
      { project: 'project-one', before: { at: first.startedAt, id: first.id } },
    ])
  })

  test('returns not found when the tenant-bound reader cannot see the project', async () => {
    const app = appWith(identity, { readReleases: async () => null })
    const response = await app.request('/v1/releases?project=unknown')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'project not found' })
  })

  test('refuses an ambiguous visible project and returns no releases', async () => {
    let latestRead = false
    const app = appWith(
      {
        ...identity,
        memberships: [
          identity.memberships[0]!,
          {
            space_id: 'space-b',
            name: 'Space B',
            slug: 'space-b',
            role: 'member',
            permission: 'read',
          },
        ],
      },
      {
        readReleases: async () => {
          throw new RecordReleaseSpaceRequiredError(
            'project exists in more than one record space; select a space',
          )
        },
        readLatestReleases: async () => {
          latestRead = true
          throw new RecordReleaseSpaceRequiredError(
            'project exists in more than one record space; select a space',
          )
        },
      },
    )
    for (const path of [
      '/v1/releases?project=project-one',
      '/v1/releases/latest?project=project-one',
    ]) {
      const response = await app.request(path)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        error: 'project exists in more than one record space; select a space',
        remedy: 'send x-record-space to select the record space',
      })
    }
    expect(latestRead).toBe(true)
  })

  test('a requested space resolves releases within that space', async () => {
    const selected: Array<{ spaceId: string; spaceIds: string[] }> = []
    const app = appWith(
      {
        ...identity,
        memberships: [
          identity.memberships[0]!,
          {
            space_id: 'space-b',
            name: 'Space B',
            slug: 'space-b',
            role: 'member',
            permission: 'read',
          },
        ],
      },
      {
        readReleases: async (input: { spaceId: string; spaceIds: string[] }) => {
          selected.push({ spaceId: input.spaceId, spaceIds: input.spaceIds })
          return [first]
        },
      },
    )
    const response = await app.request('/v1/releases?project=project-one', {
      headers: { 'x-record-space': 'space-b' },
    })
    expect(response.status).toBe(200)
    expect((await response.json()) as { items: unknown[] }).toMatchObject({ items: [first] })
    expect(selected).toEqual([{ spaceId: 'space-b', spaceIds: ['space-b'] }])
  })

  test('returns the latest release reading and refuses a missing session', async () => {
    const latest = [{ rung: 'production', lastGood: first, latestAttempt: null }]
    const app = appWith(identity, { readLatestReleases: async () => latest })
    expect(await (await app.request('/v1/releases/latest?project=project-one')).json()).toEqual({
      items: latest,
    })
    const refused = await appWith(null).request('/v1/releases?project=project-one')
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ error: 'record authentication required' })
  })
})
