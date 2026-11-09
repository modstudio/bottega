import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { encodeContextItem } from '../doc/context-item-codec.ts'
import { recordDocLintRefusal } from '../doc/doc-write-allowed.ts'
import { checkRecordCommands } from './record-doc-command-check.ts'
import { recordDocRevisionIdentityRefusal } from './record-doc-mapping.ts'
import { assertContextItemShape } from './record-docs.ts'

const doc = (body: string) => ({
  scope: 'machine',
  subject: null,
  slug: 'record-service',
  body,
  kind: 'working' as const,
  status: 'current' as const,
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

  test('allows archived and superseded document content unchanged', () => {
    expect(
      recordDocLintRefusal({ ...doc('This was called legacy.'), status: 'archived' }),
    ).toBeNull()
    expect(
      recordDocLintRefusal({ ...doc('This was called legacy.'), status: 'superseded' }),
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

test('hosted import refuses an unknown customer command and accepts a known one', () => {
  const imported = {
    body: `Run \`${PLATFORM_SLUG} task not-a-command\`.`,
    kind: 'article',
    form: 'feature',
    audiences: ['customer'],
  } as const
  expect(() =>
    checkRecordCommands(imported, imported.kind, imported.form, imported.audiences),
  ).toThrow(`${PLATFORM_SLUG} task not-a-command`)
  expect(() =>
    checkRecordCommands(
      { ...imported, body: `Run \`${PLATFORM_SLUG} task show DEV-1353\`.` },
      imported.kind,
      imported.form,
      imported.audiences,
    ),
  ).not.toThrow()
})

test('the hosted record refuses a context item that does not decode or breaks its item rules', () => {
  expect(() => assertContextItemShape('context', 'raw', 'No frontmatter.')).toThrow(
    'requires YAML frontmatter',
  )
  const ruling = encodeContextItem({ kind: 'ruling', source: 'q5282', body: 'Ship it.' })
  expect(() => assertContextItemShape('context', 'ship', ruling)).not.toThrow()
  expect(() =>
    assertContextItemShape(
      'context',
      'unsourced',
      encodeContextItem({ kind: 'ruling', source: ' ', body: 'Ship it.' }),
    ),
  ).toThrow('non-empty source')
  expect(() =>
    assertContextItemShape(
      'context',
      'empty-ruling',
      encodeContextItem({ kind: 'ruling', source: 'q5282', body: '' }),
    ),
  ).toThrow('non-empty body')
  expect(() =>
    assertContextItemShape(
      'context',
      'finding',
      encodeContextItem({ kind: 'fact', source: 'run:1', body: 'Measured result.' }),
    ),
  ).not.toThrow()
  expect(() =>
    assertContextItemShape(
      'context',
      'next',
      encodeContextItem({ kind: 'next-action', source: 'run:1', body: 'Continue.' }),
    ),
  ).not.toThrow()
  expect(() => assertContextItemShape('machine', 'raw', 'No frontmatter.')).not.toThrow()
})

test('the hosted record allows task keys in context item bodies', () => {
  expect(
    recordDocLintRefusal({
      ...doc('Dispatch DEV-2224 next.'),
      scope: 'context',
      subject: 'task:DEV-1844',
      slug: 'next',
    }),
  ).toBeNull()
})
