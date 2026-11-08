import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { Hono } from 'hono'
import { newRecordId } from '../../../shared/record-id.ts'
import { renderRecordApiRefusal } from './record-api-errors.ts'
import { registerRecordProjectRoutes } from './record-api-projects.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  classifyProjectWriteRefusal,
  parseProjectSpaceConflictResponse,
  RecordProjectSpaceConflictError,
  RecordProjectWriteRefusalError,
} from './record-project-space-refusal.ts'

const conflict = {
  projectId: '01990000-0000-7000-8000-000000000001',
  projectName: 'alpha',
  spaceId: '01990000-0000-7000-8000-000000000002',
}

test('only a project-table row-level-security violation becomes a project write refusal', () => {
  const projectRls = new SQL.PostgresError(
    'new row violates row-level security policy (USING expression) for table "project"',
    { code: 'ERR_POSTGRES_SERVER_ERROR', errno: 42501 as unknown as string },
  )
  expect(classifyProjectWriteRefusal(projectRls, true, conflict)).toEqual(
    new RecordProjectSpaceConflictError(conflict),
  )
  expect(classifyProjectWriteRefusal(projectRls, false, conflict)).toEqual(
    new RecordProjectWriteRefusalError(conflict.spaceId),
  )
  expect(new RecordProjectWriteRefusalError(conflict.spaceId).message).toBe(
    `record space ${conflict.spaceId} membership is read-only; A space owner or admin can change the membership permission.`,
  )

  const otherTable = new SQL.PostgresError(
    'new row violates row-level security policy for table "run"',
    { code: 'ERR_POSTGRES_SERVER_ERROR', errno: 42501 as unknown as string },
  )
  expect(classifyProjectWriteRefusal(otherTable, true, conflict)).toBeNull()

  const nonRls = new SQL.PostgresError('duplicate key value violates unique constraint', {
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: '23505',
  })
  expect(classifyProjectWriteRefusal(nonRls, true, conflict)).toBeNull()
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

test('the typed 409 client response is a project conflict without the doctor remedy', () => {
  const error = parseProjectSpaceConflictResponse(
    { code: 'project_space_conflict', error: 'ignored', ...conflict },
    409,
  )
  expect(error).toBeInstanceOf(RecordProjectSpaceConflictError)
  expect(error?.message).toContain(conflict.projectName)
  expect(error?.message).toContain(conflict.spaceId)
  expect(error?.message).not.toContain('record doctor')
})
