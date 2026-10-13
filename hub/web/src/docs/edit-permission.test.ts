import { expect, test } from 'bun:test'
import { canEditHostedDoc } from './edit-permission.ts'

const spaceId = '01990000-0000-7000-8000-000000000001'

test('hosted document editing requires write membership in the document space', () => {
  expect(
    canEditHostedDoc([{ space_id: spaceId, slug: 'workshop', permission: 'write' }], spaceId),
  ).toBeTrue()
  expect(
    canEditHostedDoc([{ space_id: spaceId, slug: 'workshop', permission: 'read' }], spaceId),
  ).toBeFalse()
  expect(
    canEditHostedDoc(
      [
        {
          space_id: '01990000-0000-7000-8000-000000000002',
          slug: 'elsewhere',
          permission: 'write',
        },
      ],
      spaceId,
    ),
  ).toBeFalse()
  expect(canEditHostedDoc([], undefined)).toBeFalse()
})
