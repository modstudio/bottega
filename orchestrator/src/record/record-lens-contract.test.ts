import { expect, test } from 'bun:test'
import { recordLensPageSchema } from './record-lens-contract.ts'

test('legacy lens profile rows default the current version id to null', () => {
  const parsed = recordLensPageSchema('lens_profile').parse({
    items: [
      {
        id: '01990000-0000-7000-8000-000000000001',
        spaceId: '01990000-0000-7000-8000-000000000002',
        lensId: '01990000-0000-7000-8000-000000000003',
        axis: 'framework',
        name: 'legacy',
        version: 1,
        body: '{}',
        enabled: true,
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    nextCursor: null,
  })

  expect(parsed).toMatchObject({ items: [{ currentVersionId: null }] })
})
