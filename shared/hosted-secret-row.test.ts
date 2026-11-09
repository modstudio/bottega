import { expect, test } from 'bun:test'
import { hostedSecretIdentityKind } from './hosted-secret-row.ts'

const activeSpace = '01990000-0000-7000-8000-000000000001'

test('an absent destination uses the active-space identity', () => {
  expect(hostedSecretIdentityKind(undefined, activeSpace)).toBe('active')
})

test('the pinned space destination uses the active-space identity', () => {
  expect(hostedSecretIdentityKind(activeSpace, activeSpace)).toBe('active')
})

test('a different destination uses the destination identity', () => {
  expect(hostedSecretIdentityKind('01990000-0000-7000-8000-000000000002', activeSpace)).toBe(
    'destination',
  )
})
