import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { retireProject, upsertProject } from '../project/projects.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import { hostedContextItemClient } from './context-item-hosted-client.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from './context-write-adapter.ts'
import { hostedDocClient } from './doc-hosted-client.ts'

const globals = globalThis as typeof globalThis & {
  [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts
}

afterEach(() => {
  delete globals[CONTEXT_FACTS_PORTS_KEY]
})

test('a project-addressed document client omits the destination only for cross-space lists', async () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'routed-docs',
    path: '/repo/routed-docs',
    settings: { space: 'docs-team' },
  })
  const destinations: Array<string | undefined> = []
  const capture = (requestDestination: { destinationSpaceId?: string } | undefined) => {
    destinations.push(requestDestination?.destinationSpaceId)
  }
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'active-space',
      personalSpaceId: 'active-space',
      memberships: [
        { space_id: 'active-space', slug: 'active', permission: 'write' },
        { space_id: 'docs-space', slug: 'docs-team', permission: 'write' },
      ],
    }),
    listDocs: async (_query, destination) => {
      capture(destination)
      return { items: [], nextCursor: null }
    },
    getDoc: async (_id, destination) => {
      capture(destination)
      return {}
    },
    getDocRevision: async (_id, destination) => {
      capture(destination)
      return {} as never
    },
    listRevisions: async (_id, destination) => {
      capture(destination)
      return []
    },
    upsertDoc: async (_input, destination) => {
      capture(destination)
      return { id: 'doc', revisionId: 'rev' }
    },
    reorderDocs: async ({ orderedIds }, destination) => {
      capture(destination)
      return { orderedIds }
    },
    importDoc: async (_input, destination) => {
      capture(destination)
      return { id: 'doc', revisionIds: [] }
    },
    importCanon: async (_input, destination) => {
      capture(destination)
      return { rows: [], deletions: [], findings: [], bootstrap: false }
    },
    deleteDoc: async (_id, _input, destination) => {
      capture(destination)
      return { id: 'doc', revisionId: 'rev' }
    },
    consumeDoc: async (_id, _input, destination) => {
      capture(destination)
      return { id: 'doc', revisionId: 'rev', alreadyConsumed: false }
    },
    restoreDoc: async (_id, _input, destination) => {
      capture(destination)
      return { id: 'doc', revisionId: 'rev' }
    },
    applySettingsPermission: async (_input, destination) => {
      capture(destination)
      return { revision: 'rev', permissions: { allow: [], ask: [], deny: [] } }
    },
    applySettingsAutoMode: async (_input, destination) => {
      capture(destination)
      return {
        revision: 'rev',
        autoMode: { allow: [], soft_deny: [], hard_deny: [], environment: [] },
      }
    },
  })
  const client = await hostedDocClient('project', 'routed-docs')
  await client.listDocs({})
  await client.listDocs({ acrossReadableSpaces: true })
  await client.getDoc('doc')
  await client.getDocRevision('revision')
  await client.listRevisions('doc')
  await client.upsertDoc({
    scope: 'project',
    subject: 'routed-docs',
    slug: 'guide',
    title: 'Guide',
    body: 'Body',
    delivery: 'demand',
    audiences: ['technical'],
    position: 0,
    projectName: 'routed-docs',
    reason: 'test',
    author: 'tester',
  })
  await client.reorderDocs({
    scope: 'project',
    subject: 'routed-docs',
    parentId: null,
    orderedIds: [],
  })
  await client.importDoc({
    doc: {
      scope: 'project',
      subject: 'routed-docs',
      slug: 'guide',
      title: 'Guide',
      body: 'Body',
      delivery: 'demand',
      projectName: 'routed-docs',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
    },
    revisions: [],
  })
  await client.importCanon({
    address: {
      kind: 'project',
      subject: 'routed-docs',
      projectId: '01990000-0000-7000-8000-000000000001',
    },
    rows: [],
    expectedRevisions: {},
    reason: 'test',
    author: 'tester',
  })
  await client.deleteDoc('doc', { reason: 'test', author: 'tester' })
  await client.consumeDoc('doc', { reason: 'test', author: 'tester' })
  await client.restoreDoc('doc', { revisionId: 'rev', reason: 'test', author: 'tester' })
  await client.applySettingsPermission({
    target: { kind: 'project', project: 'routed-docs' },
    list: 'allow',
    rule: 'read',
    operation: 'add',
    reason: 'test',
    expectedRevision: 'rev',
  })
  await client.applySettingsAutoMode({
    target: { kind: 'project', project: 'routed-docs' },
    list: 'allow',
    rule: 'Bash(docker compose *)',
    operation: 'add',
    reason: 'test',
    expectedRevision: 'rev',
  })
  expect(destinations).toEqual([
    'docs-space',
    undefined,
    'docs-space',
    undefined,
    ...Array.from({ length: 10 }, () => 'docs-space'),
  ])
})

test('a non-project document client binds every call to the personal space', async () => {
  const destinations: Array<string | undefined> = []
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'organization-space',
      personalSpaceId: 'personal-space',
      memberships: [],
    }),
    listDocs: async (_query, destination) => {
      destinations.push(destination?.destinationSpaceId)
      return { items: [], nextCursor: null }
    },
    upsertDoc: async (_input, destination) => {
      destinations.push(destination?.destinationSpaceId)
      return { id: 'doc', revisionId: 'rev' }
    },
  })
  const client = await hostedDocClient('settings', null)
  await client.listDocs({})
  await client.upsertDoc({
    scope: 'settings',
    subject: null,
    owner: 'user-a',
    slug: 'settings',
    title: 'Settings',
    body: '{}',
    delivery: 'demand',
    audiences: ['technical'],
    position: 0,
    reason: 'test',
    author: 'user-a',
  })
  expect(destinations).toEqual(['personal-space', 'personal-space'])
})

test('a hosted write refuses a frontmatter-only document row', async () => {
  let writes = 0
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'personal-space',
      personalSpaceId: 'personal-space',
      memberships: [],
    }),
    upsertDoc: async () => {
      writes += 1
      return { id: 'doc', revisionId: 'rev' }
    },
  })
  const client = await hostedDocClient('settings', null)
  await expect(
    client.upsertDoc({
      scope: 'settings',
      subject: null,
      owner: 'user-a',
      slug: 'settings',
      title: 'Settings',
      body: '---\ndescription: partial\n---',
      bodyTrimmed: true,
      delivery: 'demand',
      audiences: ['technical'],
      position: 0,
      reason: 'test',
      author: 'user-a',
    }),
  ).rejects.toThrow('read the full document body, then retry')
  expect(writes).toBe(0)
})

test('a mismatched project route discards the speculative page and reads the confirmed space', async () => {
  const project = 'mismatched-routed-docs'
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path: `/repo/${project}`,
    settings: { space: 'confirmed-team' },
  })
  rememberProjectSpace(db(), project, 'seeded-space')
  const destinations: string[] = []
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'confirmed-space',
      personalSpaceId: 'personal-space',
      memberships: [{ space_id: 'confirmed-space', slug: 'confirmed-team', permission: 'write' }],
    }),
    listDocs: async (_query, destination) => {
      const space = destination?.destinationSpaceId ?? 'unbound'
      destinations.push(space)
      return { items: [{ space }], nextCursor: null }
    },
  })

  const page = await (await hostedDocClient('project', project)).listDocs({})
  expect(destinations).toEqual(['seeded-space', 'confirmed-space'])
  expect(page.items).toEqual([{ space: 'confirmed-space' }])
})

test('a missing project route waits for the confirmed space before reading', async () => {
  const project = 'uncached-routed-docs'
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path: `/repo/${project}`,
    settings: { space: 'confirmed-team' },
  })
  const events: string[] = []
  const destinations: string[] = []
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    whoami: async () => {
      events.push('destination')
      return {
        user: { id: 'user-a' },
        activeSpaceId: 'confirmed-space',
        personalSpaceId: 'personal-space',
        memberships: [{ space_id: 'confirmed-space', slug: 'confirmed-team', permission: 'write' }],
      }
    },
    listDocs: async (_query, destination) => {
      events.push('read')
      destinations.push(destination?.destinationSpaceId ?? 'unbound')
      return { items: [], nextCursor: null }
    },
  })

  const client = await hostedDocClient('project', project)
  expect(events).toEqual(['destination'])
  await client.listDocs({})
  expect(events).toEqual(['destination', 'read'])
  expect(destinations).toEqual(['confirmed-space'])
})

test('a refused confirmed destination refuses a successful speculative read', async () => {
  const project = 'refused-routed-docs'
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path: `/repo/${project}`,
    settings: { space: 'missing-team' },
  })
  rememberProjectSpace(db(), project, 'seeded-space')
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'personal-space',
      personalSpaceId: 'personal-space',
      memberships: [],
    }),
    listDocs: async () => ({ items: [{ space: 'seeded-space' }], nextCursor: null }),
  })

  const client = await hostedDocClient('project', project)
  await expect(client.listDocs({})).rejects.toMatchObject({ status: 409 })
})

const contextInput = (holderKind: 'task' | 'session', holderId: string) => ({
  holderKind,
  holderId,
  slug: 'fact',
  kind: 'fact' as const,
  body: 'Fact.',
  source: 'test',
  questionNumber: null,
  target: null,
})

test('task context binds to its project while the personal space is active', async () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'context-project',
    path: '/repo/context-project',
    settings: { space: 'context-team' },
  })
  let destination: string | undefined
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'personal-space',
      personalSpaceId: 'personal-space',
      memberships: [
        { space_id: 'personal-space', slug: 'personal', permission: 'write' },
        { space_id: 'context-space', slug: 'context-team', permission: 'write' },
      ],
    }),
    upsertContextItem: async (_input, requestDestination) => {
      destination = requestDestination?.destinationSpaceId
      return { id: newRecordId(), createdAt: 'a', updatedAt: 'b' }
    },
  })
  const holderId = newRecordId()
  const client = await hostedContextItemClient(`task:${holderId}`, {
    kind: 'task',
    projectName: 'context-project',
  })
  await client.upsert(contextInput('task', holderId))
  expect(destination).toBe('context-space')
})

function captureDestination(spaces: { space_id: string; slug: string }[]) {
  const seen: { destination?: string } = {}
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'personal-space',
      personalSpaceId: 'personal-space',
      memberships: [
        { space_id: 'personal-space', slug: 'personal', permission: 'write' },
        ...spaces.map((space) => ({ ...space, permission: 'write' })),
      ],
    }),
    upsertContextItem: async (_input, requestDestination) => {
      seen.destination = requestDestination?.destinationSpaceId
      return { id: newRecordId(), createdAt: 'a', updatedAt: 'b' }
    },
  })
  return seen
}

test('a task context subject derives its project space from its record lookup', async () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'aaa-unreadable-project',
    path: '/repo/aaa-unreadable-project',
    settings: { space: 'unreadable-team' },
  })
  upsertProject({
    recordId: newRecordId(),
    name: 'derived-project',
    path: '/repo/derived-project',
    settings: { space: 'derived-team' },
  })
  const recordId = newRecordId()
  const read: string[] = []
  globals[CONTEXT_FACTS_PORTS_KEY] = {
    task: async () => null,
    lookup: async () => null,
    record: async (id) => {
      read.push(id)
      return id === recordId
        ? { key: 'DER-1', record_id: recordId, project: 'derived-project' }
        : null
    },
    children: async () => [],
    pointer: async () => null,
  }
  const seen = captureDestination([{ space_id: 'derived-space', slug: 'derived-team' }])
  const client = await hostedContextItemClient(`task:${recordId}`)
  await client.upsert(contextInput('task', recordId))
  expect(read).toEqual([recordId])
  expect(seen.destination).toBe('derived-space')
  globals[CONTEXT_FACTS_PORTS_KEY] = {
    task: async () => null,
    lookup: async () => null,
    record: async () => null,
    children: async () => [],
    pointer: async () => null,
  }
  await expect(hostedContextItemClient(`task:${newRecordId()}`)).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('agent context set --task <KEY>'),
  })
  globals[CONTEXT_FACTS_PORTS_KEY] = {
    task: async () => null,
    lookup: async () => null,
    record: async () => {
      throw new Error('record transport unavailable')
    },
    children: async () => [],
    pointer: async () => null,
  }
  await expect(hostedContextItemClient(`task:${newRecordId()}`)).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining(
      'task record could not be read (record transport unavailable)',
    ),
  })
})

test('a session context subject writes to its checkout project space, else the personal space', async () => {
  const seen = captureDestination([{ space_id: 'checkout-space', slug: 'checkout-team' }])
  const personal = await hostedContextItemClient('session:outside-checkout')
  await personal.upsert(contextInput('session', 'outside-checkout'))
  expect(seen.destination).toBe('personal-space')
  upsertProject({
    recordId: newRecordId(),
    name: 'checkout-project',
    path: process.cwd(),
    settings: { space: 'checkout-team' },
  })
  const checkout = await hostedContextItemClient('session:inside-checkout')
  await checkout.upsert(contextInput('session', 'inside-checkout'))
  expect(seen.destination).toBe('checkout-space')
})

test('a personal document client refuses when no personal space is provisioned', async () => {
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'organization-space',
      personalSpaceId: null,
      memberships: [],
    }),
  })
  await expect(hostedDocClient('canon', null)).rejects.toMatchObject({
    message: `run \`${PLATFORM_SLUG} record sign-in\` to restore the personal space`,
    status: 409,
  })
})

test('a retired project still supplies its declared document destination', async () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'retired-routed-docs',
    path: '/repo/retired-routed-docs',
    settings: { space: 'retired-team' },
  })
  retireProject('retired-routed-docs')
  let destination: string | undefined
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'active-space',
      personalSpaceId: 'active-space',
      memberships: [
        { space_id: 'active-space', slug: 'active', permission: 'write' },
        { space_id: 'retired-space', slug: 'retired-team', permission: 'write' },
      ],
    }),
    getDoc: async (_id, requestDestination) => {
      destination = requestDestination?.destinationSpaceId
      return {}
    },
  })
  await (await hostedDocClient('project', 'retired-routed-docs')).getDoc('doc')
  expect(destination).toBe('retired-space')
})
