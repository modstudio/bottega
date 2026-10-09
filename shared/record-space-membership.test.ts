import { describe, expect, test } from 'bun:test'
import { recordSpaceMembership } from './record-space-membership.ts'

const SPACE_ID = '0199abcd-efab-7abc-8def-0123456789ab'
const OTHER_ID = '0199abcd-efab-7abc-8def-0123456789ac'
const membership = { spaceId: SPACE_ID, slug: 'ordinary' }
const shadow = { spaceId: OTHER_ID, slug: SPACE_ID }
const unrelated = { spaceId: 'space-c', slug: 'unrelated' }

describe('record space membership', () => {
  test('binds an id named in upper case', () => {
    expect(recordSpaceMembership(SPACE_ID.toUpperCase(), [membership])).toEqual(membership)
  })

  test('binds a padded id', () => {
    expect(recordSpaceMembership(`  ${SPACE_ID}  `, [membership])).toEqual(membership)
  })

  test.each([
    [shadow, unrelated],
    [unrelated, shadow],
  ])('does not bind an unknown id-shaped value by slug in either order', (...memberships) => {
    expect(recordSpaceMembership(SPACE_ID, memberships)).toBeUndefined()
  })

  test('matches a membership id that is not record-id-shaped', () => {
    expect(recordSpaceMembership('space-c', [unrelated])).toEqual(unrelated)
  })

  test('matches a plain slug exactly', () => {
    expect(recordSpaceMembership('ordinary', [membership])).toEqual(membership)
  })

  test.each([
    [unrelated, { spaceId: 'space-d', slug: 'space-c' }],
    [{ spaceId: 'space-d', slug: 'space-c' }, unrelated],
  ])('prefers an id over an equal slug in either order', (...memberships) => {
    expect(recordSpaceMembership('space-c', memberships)).toEqual(unrelated)
  })
})
