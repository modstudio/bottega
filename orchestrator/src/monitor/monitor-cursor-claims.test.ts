import { expect, test } from 'bun:test'
import { cursorClaimHealth } from './monitor-cursor-claims.ts'

test('cursor claim health preserves bound lapsed claims and splits both classes by epic', () => {
  const cursors = [
    { project: 'p', id: 1, key: 'DEV-1', session: 'alive', isEpic: true },
    { project: 'p', id: 2, key: 'DEV-2', session: 'dead', isEpic: false },
    { project: 'p', id: 3, key: 'DEV-3', session: 'alive', isEpic: false },
  ]
  const claims = [{ project: 'p', key: 'DEV-1', session: 'alive', live: true }]

  expect(cursorClaimHealth(cursors, claims, new Set(['alive']))).toEqual({
    unclaimed: { epic: [], nonEpic: [2, 3] },
    ownerNotAlive: { epic: [], nonEpic: [2] },
  })
})

test('cursor claim health reports an unclaimed epic independently', () => {
  expect(
    cursorClaimHealth(
      [{ project: 'p', id: 9, key: 'DEV-9', session: 'alive', isEpic: true }],
      [],
      new Set(['alive']),
    ),
  ).toEqual({
    unclaimed: { epic: [9], nonEpic: [] },
    ownerNotAlive: { epic: [], nonEpic: [] },
  })
})
