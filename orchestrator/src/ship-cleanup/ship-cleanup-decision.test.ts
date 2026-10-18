import { describe, expect, test } from 'bun:test'
import { decideShipCleanup, type ShipCleanupRunFact } from './ship-cleanup-decision.ts'

const run = (overrides: Partial<ShipCleanupRunFact> = {}): ShipCleanupRunFact => ({
  id: 1,
  rootId: 1,
  job: 'implement',
  status: 'ok',
  branch: 'DEV-1392-c3',
  launchKey: 'DEV-1392',
  judged: true,
  worktree: '/trees/1',
  ...overrides,
})

describe('ship cleanup decision', () => {
  test('leaves a sibling branch on the same key alone', () => {
    expect(decideShipCleanup('DEV-1392-c3', [run({ branch: 'DEV-1392-c2' })])[0]).toMatchObject({
      scope: 'outside',
      artifacts: 'ignore',
      worktreeAction: 'ignore',
    })
  })

  test('keeps an unscored run artifacts and names the missing verdict', () => {
    expect(decideShipCleanup('DEV-1392-c3', [run({ judged: false })])[0]).toMatchObject({
      artifacts: 'keep',
      worktreeAction: 'close',
      reason: 'run has no recorded verdict',
    })
  })

  test('skips a live run', () => {
    expect(decideShipCleanup('DEV-1392-c3', [run({ status: 'asking' })])[0]).toMatchObject({
      artifacts: 'keep',
      worktreeAction: 'keep',
      reason: 'run is live (asking)',
    })
  })

  test('removes a lens run that targeted the branch', () => {
    expect(decideShipCleanup('DEV-1392-c3', [run({ job: 'review-lens' })])[0]).toMatchObject({
      scope: 'review-lens',
      artifacts: 'remove',
      worktreeAction: 'close',
    })
  })

  test('leaves a keyless run alone', () => {
    expect(decideShipCleanup('DEV-1392-c3', [run({ launchKey: null })])[0]).toMatchObject({
      scope: 'outside',
      artifacts: 'ignore',
      worktreeAction: 'ignore',
      reason: 'run has no task key',
    })
  })
})
