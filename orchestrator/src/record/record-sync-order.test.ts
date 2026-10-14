import { expect, test } from 'bun:test'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import { evidenceReferences } from './record-evidence-references.ts'
import { outboxOrder } from './record-sync.ts'

// The hosted service refuses a row whose parent it has not seen, so a kind added
// to the parent graph without a place in the send order would be quarantined.
test('no kind is sent in an earlier phase than a kind it can refer to', () => {
  const inversions: string[] = []
  for (const [kind, contract] of Object.entries(OUTBOX_PAYLOAD_CONTRACTS)) {
    const everyReference = Object.fromEntries(contract.columns.map((column) => [column, 'set']))
    for (const parent of evidenceReferences(kind, everyReference)) {
      if (outboxOrder(kind, 0)[0] < outboxOrder(parent.table, 0)[0]) {
        inversions.push(`${kind} before ${parent.table}`)
      }
    }
  }
  expect(inversions).toEqual([])
})

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
    { kind: 'review_read', id: 21657 },
    { kind: 'landing_triage_snapshot', id: 21640 },
    { kind: 'landing_review_carry', id: 21641 },
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
    { kind: 'review_read', id: 21657 },
    { kind: 'landing_triage_snapshot', id: 21640 },
    { kind: 'landing_review_carry', id: 21641 },
  ])
})
