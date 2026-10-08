import { expect, test } from 'bun:test'
import { taskProjectDestination } from './task-project-space.ts'

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
    { spaceId: 'space-a', slug: 'active' },
    { spaceId: 'space-b', slug: 'other' },
  ],
}

test('project destination resolves declarations, fallback, and each refusal', () => {
  expect(taskProjectDestination('defaulted', registered, identity)).toEqual({
    project: 'defaulted',
    destinationSpaceId: 'space-a',
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
