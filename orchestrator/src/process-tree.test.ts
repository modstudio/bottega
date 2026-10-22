import { expect, test } from 'bun:test'
import { sessionAnchors } from './process-tree.ts'

test('sessions under one terminal receive distinct harness anchors', () => {
  const anchors = sessionAnchors([
    { sessionId: 'one', chain: [101, 50, 20, 1] },
    { sessionId: 'two', chain: [102, 50, 20, 1] },
  ])
  expect(anchors).toEqual(
    new Map([
      ['one', 101],
      ['two', 102],
    ]),
  )
  expect([...anchors.values()]).not.toContain(50)
})
