import { expect, test } from 'bun:test'
import { ratchetVisibility } from './ratchet-visibility.ts'

test('an empty ratchet view refuses only when the comparison contains a change', () => {
  expect(ratchetVisibility({ comparisonPaths: ['changed.php'], visiblePaths: [] })).toEqual({
    visible: false,
    reason: 'ratchet could not see the working-tree change against its comparison base',
  })
  expect(
    ratchetVisibility({ comparisonPaths: ['changed.ts'], visiblePaths: ['changed.ts'] }),
  ).toEqual({ visible: true })
  expect(ratchetVisibility({ comparisonPaths: [], visiblePaths: [] })).toEqual({ visible: true })
})
