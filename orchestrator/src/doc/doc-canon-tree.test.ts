import { expect, test } from 'bun:test'
import { selectCanonWriteTree } from './doc-canon-tree.ts'

test('non-canon writes have no selected canon tree', () => {
  expect(selectCanonWriteTree({ scope: 'project', subject: 'anything' })).toBeUndefined()
})
