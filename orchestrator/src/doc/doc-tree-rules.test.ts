import { describe, expect, test } from 'bun:test'
import { type DocumentTreeWrite, documentTreeWriteRefusal } from './doc-tree-rules.ts'

const base = (overrides: Partial<DocumentTreeWrite> = {}): DocumentTreeWrite => ({
  slug: 'child',
  scope: 'project',
  subject: 'bottega',
  owner: null,
  audience: 'technical',
  parent: null,
  ancestorSlugs: [],
  children: [],
  ...overrides,
})

describe('document tree write rules', () => {
  test('user audience is accepted in both public scopes and refused elsewhere', () => {
    expect(documentTreeWriteRefusal(base({ audience: 'user' }))).toBeNull()
    expect(
      documentTreeWriteRefusal(base({ scope: 'global', subject: null, audience: 'user' })),
    ).toBeNull()
    expect(documentTreeWriteRefusal(base({ scope: 'canon', audience: 'user' }))).toContain(
      'project and global',
    )
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

  test('parent and child audiences must match in both directions', () => {
    expect(
      documentTreeWriteRefusal(base({ audience: 'user', parent: { ...base(), slug: 'parent' } })),
    ).toContain('must equal')
    expect(
      documentTreeWriteRefusal(
        base({
          priorAudience: 'technical',
          audience: 'user',
          children: [{ slug: 'leaf', audience: 'technical' }],
        }),
      ),
    ).toContain('children leaf')
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
      documentTreeWriteRefusal(
        base({ removing: true, children: [{ slug: 'leaf', audience: 'technical' }] }),
      ),
    ).toContain('has children leaf')
    expect(documentTreeWriteRefusal(base({ removing: true }))).toBeNull()
  })
})
