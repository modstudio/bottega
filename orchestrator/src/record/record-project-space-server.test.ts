import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { newRecordId } from '../../../shared/record-id.ts'
import { renderRecordApiRefusal } from './record-api-errors.ts'
import { registerRecordProjectRoutes } from './record-api-projects.ts'
import type { RecordIdentity } from './record-auth.ts'
import { RecordProjectPurgeError } from './record-project-purge-contract.ts'
import { RecordProjectSpaceConflictError } from './record-project-space-contract.ts'
import { classifyProjectWriteRefusal } from './record-project-space-server.ts'

const conflict = {
  projectId: '01990000-0000-7000-8000-000000000001',
  projectName: 'alpha',
  spaceId: '01990000-0000-7000-8000-000000000002',
}

test('only a project-table row-level-security violation becomes a project conflict', () => {
  expect(classifyProjectWriteRefusal('42501', 'project')).toBe('conflict')
  expect(classifyProjectWriteRefusal('42501', 'run')).toBe('unchanged')
  expect(classifyProjectWriteRefusal('23505', 'project')).toBe('unchanged')
  expect(classifyProjectWriteRefusal(null, null)).toBe('unchanged')
})

test('the project route renders a typed 409 naming the sent project and request space', async () => {
  const app = new Hono<{ Variables: { identity: RecordIdentity } }>()
  registerRecordProjectRoutes(
    app,
    {
      readProjects: async () => [],
      upsertProject: async () => {
        throw new RecordProjectSpaceConflictError(conflict)
      },
      retireProject: async () => ({ name: 'unused' }),
      purgeProject: async () => ({ nothingToRemove: true, tables: [] }),
    },
    {
      scope: () => ({
        url: 'postgres://unused.test/record',
        userId: newRecordId(),
        spaceId: conflict.spaceId,
        spaceIds: [conflict.spaceId],
      }),
      noSpace: (context) => context.json({ error: 'no space' }, 409),
      writeError: (context, error) => {
        const response = renderRecordApiRefusal(context, error)
        if (response) return response
        throw error
      },
    },
  )
  const response = await app.request('/v1/projects', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: conflict.projectId,
      name: conflict.projectName,
      path: '/w/alpha',
      stack: null,
      canon: false,
      settings: {},
      retiredAt: null,
    }),
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'project_space_conflict',
    error: expect.stringContaining('already recorded under another space'),
    ...conflict,
  })
})

test('the purge route binds every caller membership and renders guard refusals as 422', async () => {
  const projectId = newRecordId()
  const otherSpaceId = newRecordId()
  const routeIdentity: RecordIdentity = {
    user: { id: newRecordId(), email: 'purge-route@example.test' },
    activeSpaceId: conflict.spaceId,
    personalSpaceId: conflict.spaceId,
    memberships: [
      {
        space_id: conflict.spaceId,
        name: 'Alpha',
        slug: 'alpha',
        role: 'owner',
        permission: 'write',
      },
      { space_id: otherSpaceId, name: 'Beta', slug: 'beta', role: 'owner', permission: 'write' },
    ],
  }
  const app = new Hono<{ Variables: { identity: RecordIdentity } }>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', routeIdentity)
    await next()
  })
  registerRecordProjectRoutes(
    app,
    {
      readProjects: async () => [],
      upsertProject: async () => ({ id: projectId, name: 'unused' }),
      retireProject: async () => ({ name: 'unused' }),
      purgeProject: async (input) => {
        expect(input.spaceIds).toEqual([conflict.spaceId, otherSpaceId])
        throw new RecordProjectPurgeError('caller-owner guard failed: proof refusal')
      },
    },
    {
      scope: () => ({
        url: 'postgres://unused.test/record',
        userId: routeIdentity.user.id,
        spaceId: conflict.spaceId,
        spaceIds: [conflict.spaceId],
      }),
      noSpace: (context) => context.json({ error: 'no space' }, 409),
      writeError: (context, error) => renderRecordApiRefusal(context, error)!,
    },
  )
  const response = await app.request(`/v1/projects/${projectId}/purge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation: 'demo' }),
  })
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({ error: 'caller-owner guard failed: proof refusal' })
})
