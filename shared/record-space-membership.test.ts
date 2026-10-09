import { describe, expect, test } from 'bun:test'
import { recordSpaceMembership } from './record-space-membership.ts'

const SPACE_ID = '0199abcd-efab-7abc-8def-0123456789ab'
const OTHER_ID = '0199abcd-efab-7abc-8def-0123456789ac'
const membership = { spaceId: SPACE_ID, slug: 'ordinary' }
const shadow = { spaceId: OTHER_ID, slug: SPACE_ID }

describe('record space membership', () => {
  test('binds an id named in upper case', () => {
    expect(recordSpaceMembership(SPACE_ID.toUpperCase(), [membership])).toEqual(membership)
  })

  test('binds a padded id', () => {
    expect(recordSpaceMembership(`  ${SPACE_ID}  `, [membership])).toEqual(membership)
  })

  test.each([
    [membership, shadow],
    [shadow, membership],
  ])('never binds an id-shaped slug regardless of membership order', (...memberships) => {
    expect(recordSpaceMembership(SPACE_ID, memberships)).toEqual(membership)
  })

  test('matches a plain slug exactly', () => {
    expect(recordSpaceMembership('ordinary', [membership])).toEqual(membership)
  })

  test('returns nothing for an unknown id even when a slug equals it', () => {
    expect(recordSpaceMembership(SPACE_ID, [shadow])).toBeUndefined()
  })
})
