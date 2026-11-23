import { expect, mock, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { idleRecordApiDeps, idleSubjectDeps } from '../../test/fixtures/record-api.ts'
import { recordApiTestApp } from '../../test/fixtures/record-api-app.ts'
import { identity } from './record-api-identity.fixture.ts'
import { applyRecordSettingsPermission } from './record-settings.ts'

const id = '01990000-0000-7000-8000-000000000001'

test('hosted settings edits refuse future options without rewriting the row', async () => {
  const listRevisions = mock(async () => [])
  const upsertDoc = mock(async () => ({ id, revisionId: id }))
  const applySettingsPermission = (input: Parameters<typeof applyRecordSettingsPermission>[0]) =>
    applyRecordSettingsPermission(input, {
      listDocs: async () => [
        {
          id,
          spaceId: 'space-a',
          spaceName: 'Space A',
          scope: 'settings',
          subject: null,
          owner: 'user-a',
          slug: 'settings',
          title: 'settings',
          body: JSON.stringify({
            permissions: {},
            hooks: {},
            options: { subagentHooks: 'on', futureOption: 1 },
          }),
          delivery: 'demand',
          audiences: ['technical'],
          parentId: null,
          position: 0,
          projectName: null,
          latestRevisionId: null,
          createdAt: '2026-09-28T12:00:00.000Z',
          updatedAt: '2026-09-28T12:00:00.000Z',
          deletedAt: null,
        },
      ],
      listRevisions,
      upsertDoc,
    })
  const app = recordApiTestApp(
    identity,
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    { applySettingsPermission },
  )
  const response = await app.request('/v1/settings/permission', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-record-space': 'space-a' },
    body: JSON.stringify({
      target: { kind: 'user' },
      list: 'allow',
      rule: 'Bash(orch *)',
      operation: 'add',
      reason: 'test future option refusal',
      expectedRevision: id,
    }),
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    error: expect.stringMatching(
      new RegExp(`options\\.futureOption.*upgrade ${PLATFORM_NAME}`, 's'),
    ),
  })
  expect(listRevisions).not.toHaveBeenCalled()
  expect(upsertDoc).not.toHaveBeenCalled()
})
