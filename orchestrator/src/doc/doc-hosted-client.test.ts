import { expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { upsertProject } from '../project/projects.ts'
import { hostedDocClient } from './doc-hosted-client.ts'

test('a project-addressed document client binds every call to the declared space', async () => {
  upsertProject({
    name: 'routed-docs',
    path: '/repo/routed-docs',
    settings: { space: 'docs-team' },
  })
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
        { space_id: 'docs-space', slug: 'docs-team' },
      ],
    }),
    upsertDoc: async (input, requestDestination) => {
      destination = requestDestination?.destinationSpaceId
      return memory.upsertDoc(input)
    },
  })
  const client = await hostedDocClient('project', 'routed-docs')
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
  expect(destination).toBe('docs-space')
})
