import { expect, test } from 'bun:test'
import { requestTenant } from './record-api-tenant.ts'
import type { RecordIdentity } from './record-auth.ts'

const identity = (activeSpaceId: string): RecordIdentity => ({
  user: { id: 'user-a', email: 'a@example.test' },
  activeSpaceId,
  personalSpaceId: 'space-personal',
  memberships: [
    {
      space_id: 'space-personal',
      name: 'Personal',
      slug: 'personal',
      role: 'owner',
      permission: 'write',
    },
    {
      space_id: 'space-project',
      name: 'Project',
      slug: 'project',
      role: 'member',
      permission: 'write',
    },
  ],
})

test('request tenant reads use the named destination when one is supplied', () => {
  expect(
    requestTenant(identity('space-personal'), 'space-project', 'read', 'postgres://record', ''),
  ).toEqual({
    url: 'postgres://record',
    userId: 'user-a',
    personalSpaceId: 'space-personal',
    spaceId: 'space-project',
    spaceIds: ['space-project'],
  })
})

test('request tenant reads use the personal lens over every membership', () => {
  expect(
    requestTenant(identity('space-personal'), undefined, 'read', 'postgres://record', ''),
  ).toEqual({
    url: 'postgres://record',
    userId: 'user-a',
    personalSpaceId: 'space-personal',
    spaceId: 'space-personal',
    spaceIds: ['space-personal', 'space-project'],
  })
})

test('request tenant reads otherwise use only the active space', () => {
  expect(
    requestTenant(identity('space-project'), undefined, 'read', 'postgres://record', ''),
  ).toEqual({
    url: 'postgres://record',
    userId: 'user-a',
    personalSpaceId: 'space-personal',
    spaceId: 'space-project',
    spaceIds: ['space-project'],
  })
})

test('cross-space reads use every membership from a non-personal active space', () => {
  expect(
    requestTenant(
      identity('space-project'),
      undefined,
      'read',
      'postgres://record',
      '/v1/docs',
      undefined,
      true,
    ),
  ).toEqual({
    url: 'postgres://record',
    userId: 'user-a',
    personalSpaceId: 'space-personal',
    spaceId: 'space-project',
    spaceIds: ['space-personal', 'space-project'],
  })
})

test('cross-space reads refuse a named destination', () => {
  expect(
    requestTenant(
      identity('space-project'),
      'space-project',
      'read',
      'postgres://record',
      '/v1/docs',
      undefined,
      true,
    ),
  ).toEqual({ refused: 'cross-space-destination' })
})

test.each([
  ['/v1/questions', 'by-id'],
  ['/v1/questions', 'for-run'],
  ['/v1/questions', 'for-runs'],
  ['/v1/questions', 'for-cursor'],
  ['/v1/questions', 'open-for-cursors'],
  ['/v1/task-flow', 'flow'],
  ['/v1/task-flow/stages/00000000-0000-4000-8000-000000000001', undefined],
  ['/v1/task-flow/texts/00000000-0000-4000-8000-000000000001', undefined],
  ['/v1/task-flow/obligations/00000000-0000-4000-8000-000000000001', undefined],
])('request tenant binds every membership for keyed read %s %s', (route, readKind) => {
  expect(
    requestTenant(
      identity('space-project'),
      undefined,
      'read',
      'postgres://record',
      route,
      readKind,
    ),
  ).toMatchObject({ spaceIds: ['space-personal', 'space-project'] })
  expect(
    requestTenant(
      identity('space-project'),
      undefined,
      'read',
      'postgres://record',
      route,
      readKind,
    ),
  ).toMatchObject({ uuidKeyedRead: true })
})

test('a named destination keeps a keyed read bound to that one space', () => {
  expect(
    requestTenant(
      identity('space-project'),
      'space-project',
      'read',
      'postgres://record',
      '/v1/questions',
      'for-run',
    ),
  ).toMatchObject({ spaceId: 'space-project', spaceIds: ['space-project'] })
})

test.each([
  ['/v1/questions', 'inbox'],
  ['/v1/questions', 'rulings'],
  ['/v1/task-flow/stages', undefined],
])('list read %s %s keeps the active-space binding', (route, readKind) => {
  expect(
    requestTenant(
      identity('space-project'),
      undefined,
      'read',
      'postgres://record',
      route,
      readKind,
    ),
  ).toMatchObject({ spaceIds: ['space-project'] })
})

test('request tenant refuses a write without a named destination', () => {
  expect(
    requestTenant(identity('space-project'), undefined, 'write', 'postgres://record', ''),
  ).toEqual({
    refused: 'write-destination',
  })
})
