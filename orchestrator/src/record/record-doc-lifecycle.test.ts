import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { validateImportedDocumentLifecycles } from './record-doc-lifecycle.ts'

test('an import ignores a historical replacement that no longer exists', async () => {
  let queries = 0
  const tx = (async () => {
    queries += 1
    return []
  }) as unknown as SQL

  await expect(
    validateImportedDocumentLifecycles(
      tx,
      {
        spaceId: '00000000-0000-0000-0000-000000000001',
        scope: 'project',
        subject: 'widget',
        owner: null,
        slug: 'guide',
      },
      [
        { status: 'current', replacementSlug: null },
        { status: 'superseded', replacementSlug: 'removed-replacement' },
      ],
    ),
  ).resolves.toBeUndefined()
  expect(queries).toBe(0)
})
