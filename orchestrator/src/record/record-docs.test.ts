import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  REFERENCE_GENERATOR,
  recordDocLintRefusal,
  referenceWriteRefusal,
} from '../doc/doc-write-allowed.ts'
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
    expect(recordDocLintRefusal(doc('This was called legacy.'))).toMatch(
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

describe('hosted reference write policy', () => {
  test('the marker cannot bypass prose lint for a non-reference document', () => {
    expect(
      referenceWriteRefusal({ requestedForm: null, generator: REFERENCE_GENERATOR }),
    ).toContain('generator marker is reserved for reference documents')
    expect(recordDocLintRefusal(doc('This was called legacy.'))).not.toBeNull()
  })

  test('restore, consume, and import refuse reference documents', () => {
    for (const operation of ['restore', 'consume', 'import']) {
      expect(referenceWriteRefusal({ storedForm: 'reference' }), operation).toContain(
        `${PLATFORM_SLUG} doc reference publish`,
      )
    }
    expect(referenceWriteRefusal({ requestedForm: 'reference' }), 'new import').toContain(
      `${PLATFORM_SLUG} doc reference publish`,
    )
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
