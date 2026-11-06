import { expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { registerRecordMemberPermissionRoutes } from './record-api-member-permission-routes.ts'
import type { RecordIdentity } from './record-auth.ts'

const tenant = {
  url: 'postgres://record.test/record',
  userId: 'user-a',
  spaceId: 'space-a',
  spaceIds: ['space-a'],
}

function appWith(setSpaceMemberPermission: ReturnType<typeof mock>) {
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  registerRecordMemberPermissionRoutes(
    app,
    {
      listSpaceConfigAccess: async () => [],
      grantSpaceConfigAccess: async () => undefined,
      setSpaceMemberPermission,
      withdrawSpaceConfigAccess: async () => ({
        revokedMachineKeyIds: [],
        readableSecretKeys: [],
      }),
    },
    {
      scope: () => tenant,
      noSpace: () => Response.json({ error: 'no space' }, { status: 422 }),
      writeError: (_context, error) => {
        throw error
      },
    },
  )
  return app
}

test('member permission route validates its body and forwards parsed input', async () => {
  const setSpaceMemberPermission = mock(async () => ({ permission: 'read' as const }))
  const app = appWith(setSpaceMemberPermission)

  const invalid = await app.request('/v1/members/permission', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'member@example.test', permission: 'admin' }),
  })
  expect(invalid.status).toBe(422)
  expect(setSpaceMemberPermission).not.toHaveBeenCalled()

  const valid = await app.request('/v1/members/permission', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'member@example.test', permission: 'read' }),
  })
  expect(valid.status).toBe(200)
  expect(await valid.json()).toEqual({ permission: 'read' })
  expect(setSpaceMemberPermission).toHaveBeenCalledWith({
    ...tenant,
    email: 'member@example.test',
    permission: 'read',
  })
})
