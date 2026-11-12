import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { recordWriteSpaceRefusal } from '../../../shared/record-remedies.ts'
import {
  identity as fixtureIdentity,
  idleRecordApiDeps,
  idleSubjectDeps,
} from '../../test/fixtures/record-api.ts'
import { recordApiTestApp } from '../../test/fixtures/record-api-app.ts'
import { registerRecordRequestSpace } from './record-api-request-space.ts'
import type { RecordIdentity } from './record-auth.ts'

type ApiEnvironment = {
  Variables: { identity: RecordIdentity; destinationSpaceId?: string }
}

const identity: RecordIdentity = {
  user: { id: 'user-a', email: 'a@example.test' },
  activeSpaceId: 'space-a',
  personalSpaceId: 'space-a',
  memberships: [
    { space_id: 'space-a', name: 'Space A', slug: 'space-a', role: 'owner', permission: 'write' },
  ],
}

test('project routes refuse an empty requested space before writes', async () => {
  const writes: Array<string | undefined> = []
  const app = new Hono<ApiEnvironment>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', identity)
    return next()
  })
  registerRecordRequestSpace(app)
  app.put('/v1/projects', (context) => {
    writes.push(context.get('destinationSpaceId'))
    return context.json({ ok: true })
  })

  for (const requested of ['', '   ']) {
    const response = await app.request('/v1/projects', {
      method: 'PUT',
      headers: { 'x-record-space': requested },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: expect.stringMatching(/^signed-in user is not a member of record space\s*$/),
      remedy: expect.stringContaining('an invitation from a member of that space is needed'),
    })
  }
  expect(writes).toEqual([])
})

test('release routes authorize and bind a requested space', async () => {
  const destinations: Array<string | undefined> = []
  const app = new Hono<ApiEnvironment>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', {
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
    })
    return next()
  })
  registerRecordRequestSpace(app)
  for (const path of ['/v1/releases', '/v1/releases/latest']) {
    app.get(path, (context) => {
      destinations.push(context.get('destinationSpaceId'))
      return context.json({ ok: true })
    })
  }
  for (const path of ['/v1/releases', '/v1/releases/latest']) {
    const response = await app.request(path, {
      headers: { 'x-record-space': 'space-b' },
    })
    expect(response.status).toBe(200)
  }
  expect(destinations).toEqual(['space-b', 'space-b'])
})

test('every v1 route receives requested-space authorization', async () => {
  const app = new Hono<ApiEnvironment>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', identity)
    return next()
  })
  registerRecordRequestSpace(app)
  app.post('/v1/new-write-family', (context) =>
    context.json({ destination: context.get('destinationSpaceId') }),
  )

  const response = await app.request('/v1/new-write-family', {
    method: 'POST',
    headers: { 'x-record-space': 'space-a' },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ destination: 'space-a' })
})

test('task-flow write routes authorize and bind a requested space', async () => {
  const destinations: Array<string | undefined> = []
  const app = new Hono<ApiEnvironment>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', {
      ...identity,
      memberships: [
        identity.memberships[0]!,
        {
          space_id: 'space-write',
          name: 'Write Space',
          slug: 'space-write',
          role: 'member',
          permission: 'write',
        },
        {
          space_id: 'space-read',
          name: 'Read Space',
          slug: 'space-read',
          role: 'member',
          permission: 'read',
        },
      ],
    })
    return next()
  })
  registerRecordRequestSpace(app)
  app.post('/v1/task-flow/compose', (context) => {
    destinations.push(context.get('destinationSpaceId'))
    return context.json({ ok: true })
  })

  const allowed = await app.request('/v1/task-flow/compose', {
    method: 'POST',
    headers: { 'x-record-space': 'space-write' },
  })
  expect(allowed.status).toBe(200)
  expect(destinations).toEqual(['space-write'])

  const refused = await app.request('/v1/task-flow/compose', {
    method: 'POST',
    headers: { 'x-record-space': 'space-read' },
  })
  expect(refused.status).toBe(403)
  expect(await refused.json()).toEqual({
    error: 'record space space-read membership is read-only',
    remedy: 'A space owner or admin can change the membership permission.',
  })
  expect(destinations).toEqual(['space-write'])
})

test('task-flow stage lists authorize and bind a requested space', async () => {
  const destinations: Array<string | undefined> = []
  const app = new Hono<ApiEnvironment>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', {
      ...identity,
      memberships: [
        identity.memberships[0]!,
        {
          space_id: 'space-read',
          name: 'Read Space',
          slug: 'space-read',
          role: 'member',
          permission: 'read',
        },
      ],
    })
    return next()
  })
  registerRecordRequestSpace(app)
  app.get('/v1/task-flow/stages', (context) => {
    destinations.push(context.get('destinationSpaceId'))
    return context.json({ items: [], truncated: false })
  })

  const response = await app.request('/v1/task-flow/stages?taskKey=DEV-2234', {
    headers: { 'x-record-space': 'space-read' },
  })
  expect(response.status).toBe(200)
  expect(destinations).toEqual(['space-read'])
})

test('config-access routes authorize and bind a requested space', async () => {
  const destinations: Array<string | undefined> = []
  const app = new Hono<ApiEnvironment>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', identity)
    return next()
  })
  registerRecordRequestSpace(app)
  const paths = ['/v1/config-access', '/v1/config-access/grant']
  for (const path of paths) {
    app.post(path, (context) => {
      destinations.push(context.get('destinationSpaceId'))
      return context.json({ ok: true })
    })
  }
  for (const path of paths) {
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'x-record-space': 'space-a' },
    })
    expect(response.status).toBe(200)
  }
  expect(destinations).toEqual(['space-a', 'space-a'])
})

test('read-only members are refused before remaining tenant write routes run', async () => {
  // Production break watched: register request-space authorization only for projects and docs.
  const writes: string[] = []
  const app = new Hono<ApiEnvironment>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', {
      ...identity,
      memberships: identity.memberships.map((membership) => ({
        ...membership,
        permission: 'read',
      })),
    })
    return next()
  })
  registerRecordRequestSpace(app)
  for (const path of [
    '/v1/config/entries/key',
    '/v1/runs/run-id/score',
    '/v1/runs/run-id/void',
    '/v1/runs/run-id/unvoid',
    '/v1/snapshots/state',
    '/v1/outside-intake',
    '/v1/outside-blocks',
    '/v1/moderation/hide',
  ]) {
    app.all(path, (context) => {
      writes.push(context.req.path)
      return context.json({ ok: true })
    })
  }

  for (const [path, method] of [
    ['/v1/config/entries/key', 'PUT'],
    ['/v1/runs/run-id/score', 'PUT'],
    ['/v1/runs/run-id/void', 'POST'],
    ['/v1/runs/run-id/unvoid', 'POST'],
    ['/v1/snapshots/state', 'PUT'],
    ['/v1/outside-intake', 'POST'],
    ['/v1/outside-blocks', 'POST'],
    ['/v1/moderation/hide', 'POST'],
  ] as const) {
    const response = await app.request(path, {
      method,
      headers: { 'x-record-space': 'space-a' },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'record space space-a membership is read-only',
      remedy: 'A space owner or admin can change the membership permission.',
    })
  }
  expect(writes).toEqual([])
})

test('remaining tenant write routes judge and bind the requested destination space', async () => {
  // Production break watched: judge the active space or omit the requested destination binding.
  const destinations: Array<string | undefined> = []
  const app = new Hono<ApiEnvironment>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', {
      ...identity,
      memberships: [
        { ...identity.memberships[0]!, permission: 'read' },
        {
          space_id: 'space-b',
          name: 'Space B',
          slug: 'space-b',
          role: 'member',
          permission: 'write',
        },
      ],
    })
    return next()
  })
  registerRecordRequestSpace(app)
  for (const path of [
    '/v1/config/entries/key',
    '/v1/runs/run-id/score',
    '/v1/runs/run-id/void',
    '/v1/runs/run-id/unvoid',
    '/v1/snapshots/state',
    '/v1/outside-intake',
    '/v1/outside-blocks',
    '/v1/moderation/hide',
    '/v1/members/permission',
  ]) {
    app.all(path, (context) => {
      destinations.push(context.get('destinationSpaceId'))
      return context.json({ ok: true })
    })
  }

  for (const [path, method] of [
    ['/v1/config/entries/key', 'PUT'],
    ['/v1/runs/run-id/score', 'PUT'],
    ['/v1/runs/run-id/void', 'POST'],
    ['/v1/runs/run-id/unvoid', 'POST'],
    ['/v1/snapshots/state', 'PUT'],
    ['/v1/outside-intake', 'POST'],
    ['/v1/outside-blocks', 'POST'],
    ['/v1/moderation/hide', 'POST'],
    ['/v1/members/permission', 'POST'],
  ] as const) {
    const response = await app.request(path, {
      method,
      headers: { 'x-record-space': 'space-b' },
    })
    expect(response.status).toBe(200)
  }
  expect(destinations).toEqual(Array.from({ length: 9 }, () => 'space-b'))
})

test('catalogue routes authorize and bind their requested space before services run', async () => {
  const calls: Array<{ path: string; destination?: string }> = []
  const app = new Hono<ApiEnvironment>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', {
      ...identity,
      memberships: [
        identity.memberships[0]!,
        {
          space_id: 'space-b',
          name: 'Space B',
          slug: 'space-b',
          role: 'member',
          permission: 'write',
        },
        {
          space_id: 'space-read',
          name: 'Read Space',
          slug: 'space-read',
          role: 'member',
          permission: 'read',
        },
      ],
    })
    return next()
  })
  registerRecordRequestSpace(app)
  for (const prefix of ['lens', 'workflow', 'port']) {
    app.all(`/v1/${prefix}-catalogue/*`, (context) => {
      calls.push({ path: context.req.path, destination: context.get('destinationSpaceId') })
      return context.json({ ok: true })
    })
  }

  for (const prefix of ['lens', 'workflow', 'port']) {
    const read = await app.request(`/v1/${prefix}-catalogue/items`, {
      headers: { 'x-record-space': 'space-b' },
    })
    expect(read.status).toBe(200)
    const write = await app.request(`/v1/${prefix}-catalogue/import`, {
      method: 'POST',
      headers: { 'x-record-space': 'space-b' },
    })
    expect(write.status).toBe(200)
    const foreign = await app.request(`/v1/${prefix}-catalogue/items`, {
      headers: { 'x-record-space': 'space-foreign' },
    })
    expect(foreign.status).toBe(403)
    const readOnly = await app.request(`/v1/${prefix}-catalogue/import`, {
      method: 'POST',
      headers: { 'x-record-space': 'space-read' },
    })
    expect(readOnly.status).toBe(403)
  }
  expect(calls).toEqual(
    ['lens', 'workflow', 'port'].flatMap((prefix) => [
      { path: `/v1/${prefix}-catalogue/items`, destination: 'space-b' },
      { path: `/v1/${prefix}-catalogue/import`, destination: 'space-b' },
    ]),
  )
})
const concreteWriteMethods = new Set(['DELETE', 'PATCH', 'POST', 'PUT'])
const recordWriteExemptions = new Map([
  ['ALL /api/auth/*', 'Better Auth owns its user-scoped routes'],
  ['PUT /v1/active-space', 'the active-space switcher changes only the read default'],
  ['PUT /v1/machine/name', 'machine identity is user-scoped'],
  ['POST /v1/machine/retire', 'machine identity is user-scoped'],
  [
    'POST /v1/spaces/delete-trial',
    'the body names the deleted space and the delete service authorizes the caller against it',
  ],
  [
    'POST /v1/spaces/delete',
    'the body names the deleted space and the delete service authorizes the caller against it',
  ],
  ['POST /v1/sync', 'sync resolves every row destination through its S5 write-space seam'],
])
const recordTenantRoutes = new Set(
  `
PUT /v1/subjects
POST /v1/subjects/:id/rename
POST /v1/subjects/:id/define
POST /v1/subjects/reorder
POST /v1/subjects/:id/retire
PUT /v1/projects
POST /v1/projects/:id/retire
POST /v1/projects/:id/purge
POST /v1/settings/permission
POST /v1/settings/auto-mode
PUT /v1/board/successor
PUT /v1/board/messages
POST /v1/board/messages/:id/replies
POST /v1/board/messages/:id/withdraw
POST /v1/board/messages/:id/accept
POST /v1/board/messages/:id/filing-lease/complete
POST /v1/board/messages/:id/filing-lease/fail
POST /v1/board/messages/:id/filing-lease
PUT /v1/board/receipts
PUT /v1/board/claims
POST /v1/board/claims/release-task
POST /v1/board/claims/:id/renew
POST /v1/board/claims/:id/release
POST /v1/config/machine-keys/:keyId/claim-challenge
POST /v1/config/machine-keys/:keyId/claim
POST /v1/config-access/grant
POST /v1/config-access/withdraw
POST /v1/members/permission
POST /v1/outside-intake
POST /v1/outside-intake/pause
POST /v1/outside-intake/resume
POST /v1/outside-blocks
DELETE /v1/outside-blocks/:userId
POST /v1/moderation/hide
POST /v1/moderation/unhide
PUT /v1/docs/order
POST /v1/docs/rename-subject
POST /v1/catalogues/ensure-built-ins
PUT /v1/lens-catalogue/lenses
POST /v1/lens-catalogue/import
PUT /v1/lens-catalogue/profiles
PUT /v1/lens-catalogue/selections
POST /v1/port-catalogue/write
POST /v1/port-catalogue/import
POST /v1/task-flow/compose
POST /v1/task-flow/stage-update
POST /v1/task-flow/advance
POST /v1/task-flow/await-ruling
POST /v1/task-flow/abandon
POST /v1/task-flow/adopt
POST /v1/task-flow/attach-text
POST /v1/task-flow/delete-text
POST /v1/task-flow/copy-text
POST /v1/workflow-catalogue/draft
POST /v1/workflow-catalogue/import/v2
POST /v1/workflow-catalogue/promote
POST /v1/workflow-catalogue/retire
PUT /v1/config/entries/:key
DELETE /v1/config/entries/:key
PUT /v1/config/secrets/:key
DELETE /v1/config/secrets/:key
PUT /v1/config/credential-preferences
DELETE /v1/config/credential-preferences
POST /v1/config/data-keys
POST /v1/config/data-keys/:dekId/wraps
POST /v1/config/data-keys/:dekId/retire
DELETE /v1/config/wraps/:recipientKeyId
PUT /v1/config/machine-keys/:keyId
POST /v1/config/machine-keys/:keyId/revoke
PUT /v1/docs
POST /v1/docs/import
POST /v1/docs/canon/import
DELETE /v1/docs/:id
POST /v1/docs/:id/consume
POST /v1/docs/:id/restore
PUT /v1/runs/:id/score
POST /v1/runs/:id/void
POST /v1/runs/:id/unvoid
PUT /v1/snapshots/:kind
`
    .trim()
    .split('\n'),
)

const guardId = '01990000-0000-7000-8000-000000000001'
const guardStamp = '2026-11-11T00:00:00.000Z'
const revision = { id: guardId, expectedRevision: 1 }
const recordTenantRouteBodies = new Map<string, unknown>([
  [
    'PUT /v1/docs/order',
    { scope: 'project', subject: PLATFORM_NAME, parentId: null, orderedIds: [guardId] },
  ],
  [
    'PUT /v1/docs',
    {
      scope: 'project',
      subject: PLATFORM_NAME,
      slug: 'guard',
      title: 'Guard',
      body: 'Guard.',
      reason: 'guard',
      author: 'guard',
    },
  ],
  [
    'POST /v1/docs/import',
    {
      doc: {
        scope: 'project',
        subject: PLATFORM_NAME,
        slug: 'guard',
        title: 'Guard',
        body: 'Guard.',
        delivery: 'demand',
        audiences: ['technical'],
        createdAt: guardStamp,
        updatedAt: guardStamp,
        deletedAt: null,
      },
      revisions: [],
    },
  ],
  [
    'POST /v1/docs/canon/import',
    {
      address: { kind: 'project', subject: PLATFORM_NAME, projectId: guardId },
      rows: [{ slug: 'AGENTS.md', title: 'AGENTS.md', body: 'Guard.' }],
      expectedRevisions: {},
      reason: 'guard',
      author: 'guard',
    },
  ],
  [
    'POST /v1/task-flow/compose',
    {
      requestId: guardId,
      flowChange: {
        ...revision,
        values: { updatedMachineId: guardId, updatedAt: guardStamp },
      },
    },
  ],
  [
    'POST /v1/task-flow/stage-update',
    { requestId: guardId, stages: [{ ...revision, values: {} }] },
  ],
  ['POST /v1/task-flow/advance', { requestId: guardId, stage: { ...revision, values: {} } }],
  [
    'POST /v1/task-flow/await-ruling',
    {
      requestId: guardId,
      stage: { ...revision, values: { state: 'awaiting-ruling', question: 'Proceed?' } },
    },
  ],
  [
    'POST /v1/task-flow/abandon',
    { requestId: guardId, stage: { ...revision, values: { state: 'abandoned' } } },
  ],
  [
    'POST /v1/task-flow/adopt',
    {
      requestId: guardId,
      stage: revision,
      taskId: guardId,
      updatedMachineId: guardId,
      updatedAt: guardStamp,
    },
  ],
  [
    'POST /v1/task-flow/attach-text',
    {
      requestId: guardId,
      rows: [
        {
          id: guardId,
          stageRecordId: guardId,
          stepOrdinal: 1,
          stepSlug: 'guard',
          body: 'Guard.',
          createdAt: guardStamp,
        },
      ],
    },
  ],
  [
    'POST /v1/task-flow/delete-text',
    { requestId: guardId, stageRecordId: guardId, ids: [guardId] },
  ],
  [
    'POST /v1/task-flow/copy-text',
    {
      requestId: guardId,
      row: {
        id: guardId,
        workflowTextRecordId: guardId,
        stageRecordId: guardId,
        taskDocumentReference: 'DEV-2247/3',
        copiedAt: guardStamp,
      },
    },
  ],
])

test('every registered record API write resolves a refusing tenant or names its exemption', () => {
  const app = recordApiTestApp(fixtureIdentity, {
    ...idleRecordApiDeps(),
    ...idleSubjectDeps(),
    deleteTrialSpace: async () => ({
      nothingToRemove: true,
      activeSpaceCleared: false,
      tables: [],
      neutralized: [],
    }),
    deleteSpace: async () => ({
      nothingToRemove: true,
      activeSpaceCleared: false,
      tables: [],
      neutralized: [],
    }),
  })
  const routes = new Set(
    app.routes
      .filter(
        (route) =>
          concreteWriteMethods.has(route.method) ||
          `${route.method} ${route.path}` === 'ALL /api/auth/*',
      )
      .map((route) => `${route.method} ${route.path}`),
  )
  const classified = new Set([...recordTenantRoutes, ...recordWriteExemptions.keys()])
  expect(routes).toEqual(classified)
})

test('every classified record tenant write reaches its refusing seam', async () => {
  const app = recordApiTestApp(fixtureIdentity, {
    ...idleRecordApiDeps(),
    ...idleSubjectDeps(),
    writeTaskFlow: async () => ({}),
  })
  const refusal = recordWriteSpaceRefusal()
  const failures: string[] = []
  for (const route of recordTenantRoutes) {
    const separator = route.indexOf(' ')
    const method = route.slice(0, separator)
    const path = route
      .slice(separator + 1)
      .replace(/:[^/]+/g, '01990000-0000-7000-8000-000000000001')
    const response = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(recordTenantRouteBodies.get(route) ?? {}),
    })
    const body = await response.json().catch(() => null)
    if (response.status !== refusal.status || JSON.stringify(body) !== JSON.stringify(refusal.body))
      failures.push(`${route}: ${response.status} ${JSON.stringify(body)}`)
  }
  expect(failures).toEqual([])
})
