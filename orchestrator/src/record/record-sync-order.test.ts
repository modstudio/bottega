import { expect, test } from 'bun:test'
import { outboxOrder } from './record-sync.ts'

test('outbox ordering sends run rows before run-dependent rows', () => {
  const rows = [
    { kind: 'question', id: 21647 },
    { kind: 'score', id: 21649 },
    { kind: 'run', id: 21650 },
    { kind: 'landing', id: 21648 },
    { kind: 'review', id: 21651 },
    { kind: 'run', id: 21652 },
    { kind: 'review_lens', id: 21653 },
    { kind: 'review_finding', id: 21654 },
    { kind: 'contention', id: 21655 },
    { kind: 'test_flake', id: 21656 },
  ]

  const ordered = rows.toSorted((left, right) => {
    const [leftPhase, leftId] = outboxOrder(left.kind, left.id)
    const [rightPhase, rightId] = outboxOrder(right.kind, right.id)
    return leftPhase - rightPhase || leftId - rightId
  })

  expect(ordered).toEqual([
    { kind: 'run', id: 21650 },
    { kind: 'run', id: 21652 },
    { kind: 'landing', id: 21648 },
    { kind: 'test_flake', id: 21656 },
    { kind: 'question', id: 21647 },
    { kind: 'score', id: 21649 },
    { kind: 'review', id: 21651 },
    { kind: 'review_lens', id: 21653 },
    { kind: 'review_finding', id: 21654 },
    { kind: 'contention', id: 21655 },
  ])
})
