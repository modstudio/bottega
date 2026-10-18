import { describe, expect, test } from 'bun:test'
import { decideShipCleanup, type ShipCleanupRunFact } from './ship-cleanup-decision.ts'

const run = (overrides: Partial<ShipCleanupRunFact> = {}): ShipCleanupRunFact => ({
  id: 1,
  rootId: 1,
  startedAt: '2026-10-18T00:00:00Z',
  job: 'implement',
  status: 'ok',
  branch: 'DEV-1392-c3',
  launchKey: 'DEV-1392',
  judged: true,
  worktree: '/trees/1',
  ...overrides,
})

describe('ship cleanup decision', () => {
  const decide = (runs: ShipCleanupRunFact[]) =>
    decideShipCleanup('DEV-1392-c3', '2026-10-18T01:00:00Z', runs)

  test('leaves a sibling branch on the same key alone', () => {
    expect(decide([run({ branch: 'DEV-1392-c2' })])[0]).toMatchObject({
      scope: 'outside',
      artifacts: 'ignore',
      worktreeAction: 'ignore',
    })
  })

  test('covers the root and turns of the chain that reached the merged branch', () => {
    const decisions = decide([
      run({ id: 1, rootId: 1, branch: 'DEV-1392-c2' }),
      run({ id: 2, rootId: 1, branch: 'DEV-1392-c3' }),
      run({ id: 3, rootId: 3, branch: 'DEV-1392-c2' }),
    ])
    expect(decisions.map(({ id, scope }) => ({ id, scope }))).toEqual([
      { id: 1, scope: 'chain' },
      { id: 2, scope: 'chain' },
      { id: 3, scope: 'outside' },
    ])
  })

  test('keeps an unscored run artifacts and names the missing verdict', () => {
    expect(decide([run({ judged: false })])[0]).toMatchObject({
      artifacts: 'keep',
      worktreeAction: 'close',
      reason: 'run has no recorded verdict',
    })
  })

  test('skips a live run', () => {
    expect(decide([run({ status: 'asking' })])[0]).toMatchObject({
      artifacts: 'keep',
      worktreeAction: 'keep',
      reason: 'run is live (asking)',
    })
  })

  test('removes a lens run that targeted the branch', () => {
    expect(decide([run({ job: 'review-lens' })])[0]).toMatchObject({
      scope: 'review-lens',
      artifacts: 'remove',
      worktreeAction: 'close',
    })
  })

  test('leaves a keyless run alone', () => {
    expect(decide([run({ launchKey: null })])[0]).toMatchObject({
      scope: 'outside',
      artifacts: 'ignore',
      worktreeAction: 'ignore',
      reason: 'run has no task key',
    })
  })

  test('leaves a later run that reused the merged branch name alone', () => {
    expect(decide([run({ startedAt: '2026-10-18T02:00:00Z' })])[0]).toMatchObject({
      scope: 'outside',
      artifacts: 'ignore',
      worktreeAction: 'ignore',
      reason: 'run started after branch landed at 2026-10-18T01:00:00Z',
    })
  })
})
