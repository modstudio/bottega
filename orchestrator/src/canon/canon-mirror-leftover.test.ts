import { expect, test } from 'bun:test'
import { decideLeftoverDisposition } from './canon-mirror-leftover.ts'

test('dirty owned leftover without an unpushed commit is reclaimed', () => {
  expect(
    decideLeftoverDisposition({
      dirty: true,
      unpushedCommitCount: 0,
      dryRun: false,
    }),
  ).toEqual({ action: 'reclaim' })
})

test('dry-run reports reclamation and an unpushed commit is refused', () => {
  expect(
    decideLeftoverDisposition({
      dirty: true,
      unpushedCommitCount: 0,
      dryRun: true,
    }),
  ).toEqual({ action: 'report', would: 'reclaim' })
  expect(
    decideLeftoverDisposition({
      dirty: false,
      unpushedCommitCount: 2,
      dryRun: false,
    }),
  ).toEqual({ action: 'refuse', reason: 'unpushed-commits' })
  expect(
    decideLeftoverDisposition({
      dirty: 'indeterminate',
      unpushedCommitCount: 0,
      dryRun: false,
    }),
  ).toEqual({ action: 'refuse', reason: 'indeterminate-cleanliness' })
})
