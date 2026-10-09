import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type DocumentTreeWrite, documentTreeWriteRefusal } from './doc-tree-rules.ts'

const base = (overrides: Partial<DocumentTreeWrite> = {}): DocumentTreeWrite => ({
  slug: 'child',
  scope: 'project',
  subject: PLATFORM_SLUG,
  owner: null,
  audiences: ['technical'],
  parent: null,
  ancestorSlugs: [],
  children: [],
  ...overrides,
})

describe('document tree write rules', () => {
  test('internal and customer audiences are accepted in project and global scopes only', () => {
    for (const audience of ['internal', 'customer'] as const) {
      expect(documentTreeWriteRefusal(base({ audiences: [audience] }))).toBeNull()
      expect(
        documentTreeWriteRefusal(base({ scope: 'global', subject: null, audiences: [audience] })),
      ).toBeNull()
      expect(documentTreeWriteRefusal(base({ scope: 'canon', audiences: [audience] }))).toContain(
        'project and global',
      )
    }
  })

  test('parent must exist, be live, and share the address', () => {
    expect(documentTreeWriteRefusal(base({ requestedParentSlug: 'missing' }))).toContain(
      'does not exist',
    )
    expect(
      documentTreeWriteRefusal(base({ parent: { ...base(), slug: 'parent', deleted: true } })),
    ).toContain('is deleted')
    expect(
      documentTreeWriteRefusal(base({ parent: { ...base(), slug: 'parent', subject: 'other' } })),
    ).toContain('share')
    expect(documentTreeWriteRefusal(base({ parent: { ...base(), slug: 'parent' } }))).toBeNull()
  })

  test('canon documents cannot have a parent or be used as one', () => {
    expect(
      documentTreeWriteRefusal(
        base({
          scope: 'canon',
          parent: { ...base(), scope: 'canon', slug: 'parent' },
        }),
      ),
    ).toContain('canon documents cannot have a parent')
    expect(
      documentTreeWriteRefusal(
        base({ parent: { ...base(), scope: 'canon', slug: 'canon-parent' } }),
      ),
    ).toContain('cannot be used as a parent')
    expect(
      documentTreeWriteRefusal(
        base({
          scope: 'canon',
          children: [{ slug: 'child' }],
        }),
      ),
    ).toContain('canon documents cannot have children child')
  })

  test('parent and child audiences are independent', () => {
    expect(
      documentTreeWriteRefusal(
        base({ audiences: ['customer'], parent: { ...base(), slug: 'parent' } }),
      ),
    ).toBeNull()
    expect(
      documentTreeWriteRefusal(
        base({
          audiences: ['internal'],
          children: [{ slug: 'leaf' }],
        }),
      ),
    ).toBeNull()
  })

  test('self and ancestor cycles are refused while unrelated parents pass', () => {
    expect(documentTreeWriteRefusal(base({ parent: { ...base() } }))).toContain('cycle')
    expect(
      documentTreeWriteRefusal(
        base({ parent: { ...base(), slug: 'leaf' }, ancestorSlugs: ['child'] }),
      ),
    ).toContain('cycle')
    expect(
      documentTreeWriteRefusal(
        base({ parent: { ...base(), slug: 'parent' }, ancestorSlugs: ['root'] }),
      ),
    ).toBeNull()
  })

  test('removing a parent is refused and removing a leaf passes', () => {
    expect(
      documentTreeWriteRefusal(base({ removing: true, children: [{ slug: 'leaf' }] })),
    ).toContain('has children leaf')
    expect(documentTreeWriteRefusal(base({ removing: true }))).toBeNull()
  })
})
