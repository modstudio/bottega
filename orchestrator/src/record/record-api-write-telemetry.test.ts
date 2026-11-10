import { expect, test } from 'bun:test'
import type { NoDestinationWriteReport } from '../../../shared/record-no-destination-write-contract.ts'
import { identity, idleRecordApiDeps, idleSubjectDeps } from '../../test/fixtures/record-api.ts'
import { recordApiTestApp } from '../../test/fixtures/record-api-app.ts'
import type { RecordIdentity } from './record-auth.ts'

const appWith = (session: RecordIdentity | null, overrides: Record<string, unknown> = {}) =>
  recordApiTestApp(session, { ...idleSubjectDeps(), ...idleRecordApiDeps() }, overrides)

const id = '01990000-0000-7000-8000-000000000001'

test('reports destination-less writes by patterned route and client cause', async () => {
  const cause = 'measurement-seams-test/1'
  const app = appWith(identity, {
    postBoardMessage: async () => ({ id }),
    hideRow: async () => ({}),
  })
  const write = (
    target: typeof app,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    target.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': cause, ...headers },
      body: JSON.stringify(body),
    })
  expect(
    (
      await app.request('/v1/board/messages', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'user-agent': cause,
          'x-record-space': 'space-a',
        },
        body: JSON.stringify({
          id,
          kind: 'notice',
          audience: 'operator',
          title: 'Measurement notice',
          body: 'This write exercises the board tenant seam.',
          expiresAt: '2027-11-09T00:00:00.000Z',
        }),
      })
    ).status,
  ).toBe(200)
  expect((await write(app, `/v1/runs/${id}/void`, { reason: 'measurement' })).status).toBe(200)
  expect(
    (
      await write(
        app,
        '/v1/moderation/hide',
        { message: id, reason: 'spam' },
        { 'x-record-space': 'space-a' },
      )
    ).status,
  ).toBe(200)
  expect((await write(app, '/v1/sync', {})).status).toBe(501)

  const spaceBIdentity: RecordIdentity = {
    ...identity,
    activeSpaceId: 'space-b',
    personalSpaceId: 'space-b',
    memberships: [
      {
        space_id: 'space-b',
        name: 'Space B',
        slug: 'space-b',
        role: 'owner',
        permission: 'write',
      },
    ],
  }
  const spaceBApp = appWith(spaceBIdentity, { hideRow: async () => ({}) })
  expect(
    (await write(spaceBApp, '/v1/moderation/hide', { message: id, reason: 'spam' })).status,
  ).toBe(200)

  const refused = await app.request('/v1/projects', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'user-agent': cause,
      'x-record-space': 'outside',
    },
    body: JSON.stringify({
      name: 'refused-measurement',
      path: '/repo/refused-measurement',
      stack: null,
      canon: false,
      settings: {},
      retiredAt: null,
    }),
  })
  expect(refused.status).toBe(403)
  expect((await appWith(null).request('/v1/health/no-destination-writes')).status).toBe(401)

  const response = await app.request('/v1/health/no-destination-writes')
  expect(response.status).toBe(200)
  const report = (await response.json()) as NoDestinationWriteReport
  expect(new Date(report.processStartedAt).toISOString()).toBe(report.processStartedAt)
  expect(report.counts.filter((row) => row.cause === cause)).toEqual([
    { spaceId: 'space-a', route: '/v1/runs/:id/void', cause, occurrences: 1 },
    { spaceId: 'space-a', route: '/v1/moderation/hide', cause, occurrences: 1 },
    { spaceId: 'space-a', route: '/v1/sync', cause, occurrences: 1 },
  ])
})
