import { expect, test } from 'bun:test'
import { decideLeftoverDisposition } from './canon-mirror-leftover.ts'

test('dirty owned leftover without an unpushed commit is reclaimed', () => {
  expect(
    decideLeftoverDisposition({
      exists: true,
      owned: true,
      dirty: true,
      hasUnpushedCommit: false,
      dryRun: false,
    }),
  ).toEqual({ action: 'reclaim' })
})

test('dry-run reports reclamation and an unpushed commit is refused', () => {
  expect(
    decideLeftoverDisposition({
      exists: true,
      owned: true,
      dirty: true,
      hasUnpushedCommit: false,
      dryRun: true,
    }),
  ).toEqual({ action: 'report', would: 'reclaim' })
  expect(
    decideLeftoverDisposition({
      exists: true,
      owned: true,
      dirty: false,
      hasUnpushedCommit: true,
      dryRun: false,
    }),
  ).toEqual({ action: 'refuse' })
})
