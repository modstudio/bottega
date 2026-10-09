import { describe, expect, test } from 'bun:test'
import { recordSpaceRole, refuseDuplicateRecordSpaceSlug } from './record-space.ts'

describe('record space decisions', () => {
  test('accepts only supported invitation roles', () => {
    expect(recordSpaceRole('member')).toBe('member')
    expect(recordSpaceRole('admin')).toBe('admin')
    expect(recordSpaceRole('owner')).toBe('owner')
    expect(() => recordSpaceRole('operator')).toThrow('must be member, admin, or owner')
  })

  test('refuses creating a second space with the same slug and names the existing id', () => {
    expect(() =>
      refuseDuplicateRecordSpaceSlug('team', [
        {
          spaceId: '01990000-0000-7000-8000-000000000003',
          slug: 'team',
          name: 'Team',
          role: 'owner',
          permission: 'write',
        },
      ]),
    ).toThrow('record space slug team already exists: 01990000-0000-7000-8000-000000000003')
  })

  test('refuses a slug shaped like a record id and names the ambiguity', () => {
    const slug = '01990000-0000-7000-8000-000000000003'
    expect(() => refuseDuplicateRecordSpaceSlug(slug, [])).toThrow(
      `record space slug ${slug} is shaped like a record id and would make space selection ambiguous`,
    )
  })

  test('refuses a padded slug shaped like a record id', () => {
    const slug = '  01990000-0000-7000-8000-000000000003  '
    expect(() => refuseDuplicateRecordSpaceSlug(slug, [])).toThrow(
      'is shaped like a record id and would make space selection ambiguous',
    )
  })
})
