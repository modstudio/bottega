import { describe, expect, test } from 'bun:test'
import { recordDocLintRefusal } from '../doc/doc-write-allowed.ts'

const doc = (body: string) => ({
  scope: 'machine',
  subject: null,
  slug: 'record-service',
  body,
})

describe('record service doc lint', () => {
  test('refuses an invalid new document', () => {
    expect(recordDocLintRefusal(doc('This was formerly different.'))).toContain('doc/history')
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
