import { expect, test } from 'bun:test'
import { selectDocWriteTree } from './doc-write-tree.ts'

test('non-canon writes have no selected canon tree', () => {
  expect(selectDocWriteTree({ scope: 'project', subject: 'anything' })).toBeUndefined()
})
