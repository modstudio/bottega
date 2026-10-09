import { expect, test } from 'bun:test'
import { classifyHostedChangeDelete, classifyHostedChangeUpsert } from './hosted-change-family.ts'

test('change classifications depend only on the gathered row values', () => {
  expect(classifyHostedChangeDelete('space-one', 'space-one')).toBe('apply')
  expect(classifyHostedChangeDelete(null, 'space-one')).toBe('skip')
  expect(classifyHostedChangeDelete('space-two', 'space-one')).toBe('skip')
  expect(classifyHostedChangeUpsert({ text: 'same' }, { text: 'same' })).toEqual({
    kind: 'no-op',
    differingColumns: [],
  })
  expect(
    classifyHostedChangeUpsert(
      { text: 'before', status: 'open' },
      { text: 'after', status: 'open' },
    ),
  ).toEqual({ kind: 'changed', differingColumns: ['text'] })
})
