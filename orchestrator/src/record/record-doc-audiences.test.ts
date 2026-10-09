import { expect, test } from 'bun:test'
import { recordDocAudiences } from './record-doc-audiences.ts'

test('hosted document reads tolerate the retired user audience as internal', () => {
  expect(recordDocAudiences(['technical', 'user'])).toEqual(['technical', 'internal'])
  expect(recordDocAudiences(['user', 'internal'])).toEqual(['internal'])
})
