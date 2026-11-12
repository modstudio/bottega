import { expect, test } from 'bun:test'
import { RECORD_PERSONAL_SPACE_REMEDY } from '../../shared/record-remedies.ts'
import { personalRecordSpace } from './personal-record-space.ts'
import { partitionProjectRows, taskProjectDestination } from './task-project-space.ts'

const registered = [
  { name: 'defaulted', settings: {} },
  { name: 'by-slug', settings: { space: 'other' } },
  { name: 'by-id', settings: { space: 'space-b' } },
  { name: 'unknown-space', settings: { space: 'missing' } },
]
const identity = {
  userId: 'user-a',
  activeSpaceId: 'space-a',
  memberships: [
    { spaceId: 'space-a', slug: 'active', permission: 'write' },
    { spaceId: 'space-b', slug: 'other', permission: 'write' },
  ],
}

test('project destination resolves declarations and each refusal', () => {
  expect(taskProjectDestination('defaulted', registered, identity)).toEqual({
    project: 'defaulted',
    refused: 'undeclared-project',
  })
  expect(taskProjectDestination('by-slug', registered, identity)).toEqual({
    project: 'by-slug',
    destinationSpaceId: 'space-b',
  })
  expect(taskProjectDestination('by-id', registered, identity)).toEqual({
    project: 'by-id',
    destinationSpaceId: 'space-b',
  })
  expect(taskProjectDestination('unknown-space', registered, identity)).toEqual({
    project: 'unknown-space',
    refused: 'declared-space-not-member',
  })
  expect(taskProjectDestination('unregistered', registered, identity)).toEqual({
    project: 'unregistered',
    refused: 'unregistered-project',
  })
})

test('a row without a project targets the personal space instead of the active space', async () => {
  const row = { id: 'machine-row', project_name: null }
  const partitioned = await partitionProjectRows([row], registered, identity, () =>
    personalRecordSpace({
      token: 'session',
      fetch: async () =>
        Response.json({
          user: { id: 'user-a' },
          activeSpaceId: identity.activeSpaceId,
          personalSpaceId: 'space-personal',
          memberships: identity.memberships,
        }),
    }),
  )

  expect([...partitioned.destinations]).toEqual([['space-personal', [row]]])
  expect(partitioned.destinations.has(identity.activeSpaceId)).toBe(false)
})

test('a row without a project refuses when the signed-in user has no personal space', async () => {
  expect(
    partitionProjectRows([{ id: 'machine-row', project_name: null }], registered, identity, () =>
      personalRecordSpace({
        token: 'session',
        fetch: async () =>
          Response.json({
            user: { id: 'user-a' },
            activeSpaceId: identity.activeSpaceId,
            personalSpaceId: null,
            memberships: identity.memberships,
          }),
      }),
    ),
  ).rejects.toThrow(`record user has no personal space; ${RECORD_PERSONAL_SPACE_REMEDY}`)
})
