import { expect, test } from 'bun:test'
import { intervalOwningProject, taskProjectDestination } from './task-project-space.ts'

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

test('an unregistered interval project follows the sole owner of its task prefix', () => {
  const projects = [
    { name: 'alpha', settings: { keyPrefixes: ['ALP'] } },
    { name: 'beta', settings: { keyPrefixes: ['BET'] } },
  ]
  expect(intervalOwningProject('temporary', 'ALP-12', projects)).toBe('alpha')
  expect(intervalOwningProject('temporary', 'OTHER-12', projects)).toBe('temporary')
  expect(
    intervalOwningProject('temporary', 'SHR-12', [
      ...projects,
      { name: 'gamma', settings: { keyPrefixes: ['SHR'] } },
      { name: 'delta', settings: { keyPrefixes: ['SHR'] } },
    ]),
  ).toBe('temporary')
  expect(intervalOwningProject('temporary', null, projects)).toBe('temporary')
})

test('a registered interval project is never changed by its task prefix', () => {
  const projects = [
    { name: 'alpha', settings: { keyPrefixes: ['ALP'] } },
    { name: 'beta', settings: { keyPrefixes: ['BET'] } },
  ]
  expect(intervalOwningProject('alpha', 'BET-12', projects)).toBe('alpha')
})
