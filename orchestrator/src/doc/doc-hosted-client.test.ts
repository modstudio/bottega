import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { retireProject, upsertProject } from '../project/projects.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from './context-write-adapter.ts'
import { hostedDocClient } from './doc-hosted-client.ts'

const globals = globalThis as typeof globalThis & {
  [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts
}

afterEach(() => {
  delete globals[CONTEXT_FACTS_PORTS_KEY]
})

test('a project-addressed document client binds every call to the declared space', async () => {
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
  await client.getDoc('doc')
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
  expect(destinations).toEqual(Array.from({ length: 12 }, () => 'docs-space'))
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
    getDoc: async (_id, requestDestination) => {
      destination = requestDestination?.destinationSpaceId
      return {}
    },
  })
  const client = await hostedDocClient('context', `task:${newRecordId()}`, {
    kind: 'task',
    projectName: 'context-project',
  })
  await client.getDoc('doc')
  expect(destination).toBe('context-space')
})

test('a task context subject derives its project space, skipping a project whose tasks cannot be read', async () => {
  upsertProject({
    recordId: newRecordId(),
    name: 'unreadable-project',
    path: '/repo/unreadable-project',
    settings: { space: 'unreadable-team' },
  })
  upsertProject({
    recordId: newRecordId(),
    name: 'derived-project',
    path: '/repo/derived-project',
    settings: { space: 'derived-team' },
  })
  const recordId = newRecordId()
  globals[CONTEXT_FACTS_PORTS_KEY] = {
    tasks: async (project) => {
      if (project === 'unreadable-project') throw new Error('task list failed')
      return project === 'derived-project'
        ? [{ key: 'DER-1', record_id: recordId, project: 'derived-project' }]
        : []
    },
    task: async () => null,
    pointer: async () => null,
  }
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
        { space_id: 'derived-space', slug: 'derived-team', permission: 'write' },
      ],
    }),
    getDoc: async (_id, requestDestination) => {
      destination = requestDestination?.destinationSpaceId
      return {}
    },
  })
  const client = await hostedDocClient('context', `task:${recordId}`)
  await client.getDoc('doc')
  expect(destination).toBe('derived-space')
  await expect(hostedDocClient('context', `task:${newRecordId()}`)).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('agent context set --task <KEY>'),
  })
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
    message: 'personal space is not provisioned',
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
