import { expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { retireProject, upsertProject } from '../project/projects.ts'
import { hostedDocClient } from './doc-hosted-client.ts'

test('a project-addressed document client binds every call to the declared space', async () => {
  upsertProject({
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
        { space_id: 'active-space', slug: 'active' },
        { space_id: 'docs-space', slug: 'docs-team' },
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
    audience: 'technical',
    position: 0,
    projectName: 'routed-docs',
    reason: 'test',
    author: 'tester',
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
    address: { kind: 'project', subject: 'routed-docs' },
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
  expect(destinations).toEqual(Array.from({ length: 10 }, () => 'docs-space'))
})

test('a retired project still supplies its declared document destination', async () => {
  upsertProject({
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
        { space_id: 'active-space', slug: 'active' },
        { space_id: 'retired-space', slug: 'retired-team' },
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
