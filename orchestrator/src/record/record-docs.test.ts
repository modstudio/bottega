import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordDocLintRefusal } from '../doc/doc-write-allowed.ts'
import { recordDocRevisionIdentityRefusal } from './record-doc-mapping.ts'

const doc = (body: string) => ({
  scope: 'machine',
  subject: null,
  slug: 'record-service',
  body,
  kind: 'working' as const,
})

describe('record service doc lint', () => {
  test('refuses an invalid new document', () => {
    expect(recordDocLintRefusal(doc('This was formerly different.'))).toMatch(
      /working profile[\s\S]*doc\/history/,
    )
  })

  test('article profile permits numerals', () => {
    expect(recordDocLintRefusal({ ...doc('There are 2 prices.'), kind: 'article' })).toBeNull()
  })

  test('allows a clean append to a legacy document', () => {
    expect(
      recordDocLintRefusal(
        doc('This was formerly different.\n\nCurrent behavior is direct.'),
        doc('This was formerly different.'),
      ),
    ).toBeNull()
  })
})

const live = {
  scope: 'project',
  subject: PLATFORM_SLUG,
  owner: null,
  slug: 'manual',
}

test('record import and restore refuse revisions from another document identity', () => {
  expect(
    recordDocRevisionIdentityRefusal(live, { ...live, slug: 'old-slug' }, 'restore'),
  ).toBeNull()
  expect(
    recordDocRevisionIdentityRefusal(live, { ...live, subject: 'other' }, 'restore'),
  ).toContain('revision scope, subject, and owner must match')
  expect(
    recordDocRevisionIdentityRefusal(live, { ...live, owner: 'other-user' }, 'import'),
  ).toContain('refusing import')
})
