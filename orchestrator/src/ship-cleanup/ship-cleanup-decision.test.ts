import { describe, expect, test } from 'bun:test'
import {
  decideShipCleanup,
  decideShipCleanupVerdict,
  decideTaskBranchesToPrune,
  type ShipCleanupRunFact,
} from './ship-cleanup-decision.ts'

const run = (overrides: Partial<ShipCleanupRunFact> = {}): ShipCleanupRunFact => ({
  record_id: '1',
  number: 1,
  root_record_id: '1',
  startedAt: '2026-10-18T00:00:00Z',
  job: 'implement',
  status: 'ok',
  branch: 'DEV-1392-c3',
  mintedBranch: 'DEV-1392-c3',
  launchKey: 'DEV-1392',
  judged: true,
  failureKind: null,
  worktree: '/trees/1',
  ...overrides,
})

describe('ship cleanup decision', () => {
  const decide = (
    runs: ShipCleanupRunFact[],
    landedBranches: ReadonlySet<string> = new Set(['DEV-1392-c3']),
  ) => decideShipCleanup('DEV-1392', landedBranches, '2026-10-18T01:00:00Z', runs)

  test('leaves a sibling branch on the same key alone', () => {
    expect(decide([run({ branch: 'DEV-1392-c2' })])[0]).toMatchObject({
      scope: 'outside',
      artifacts: 'ignore',
      worktreeAction: 'ignore',
    })
  })

  test('covers the root and turns of the chain that reached the merged branch', () => {
    const decisions = decide(
      [
        run({ record_id: '1', root_record_id: '1', branch: 'DEV-1392-c2' }),
        run({ record_id: '2', root_record_id: '1', branch: 'DEV-1392-c3' }),
        run({ record_id: '3', root_record_id: '3', branch: 'DEV-1392-c2' }),
      ],
      new Set(['DEV-1392-c2', 'DEV-1392-c3']),
    )
    expect(decisions.map(({ record_id, scope }) => ({ record_id, scope }))).toEqual([
      { record_id: '1', scope: 'chain' },
      { record_id: '2', scope: 'chain' },
      { record_id: '3', scope: 'chain' },
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

  test('treats a tree create hook tree like a landing tree, not a chain', () => {
    expect(decide([run({ job: 'hook-tree' })])[0]).toMatchObject({ scope: 'landing-tree' })
    expect(decide([run({ job: 'landing-tree' })])[0]).toMatchObject({ scope: 'landing-tree' })
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

test('cleanup verdict permits only the command tree during merge cleanup', () => {
  expect(decideShipCleanupVerdict({ kept: [], errors: [] }, false)).toEqual({ clean: true })
  const selfHold = {
    item: 'run 7 worktree',
    reason: 'copy can change without policy coupling',
    reasonKind: 'command-tree' as const,
  }
  expect(decideShipCleanupVerdict({ kept: [selfHold], errors: [] }, true)).toEqual({ clean: true })
  expect(decideShipCleanupVerdict({ kept: [selfHold], errors: [] }, false)).toEqual({
    clean: false,
    reason: 'unexpected-kept-item',
  })
  expect(decideShipCleanupVerdict({ kept: [], errors: [{}] }, true)).toEqual({
    clean: false,
    reason: 'errors',
  })
})

test('task branch pruning accepts squash, recorded PR head, and containment proof but keeps unique work', () => {
  const runs = [
    run({ launchKey: 'DEV-1392', mintedBranch: 'DEV-1392-a' }),
    run({ launchKey: 'DEV-1392', mintedBranch: 'DEV-1392-b' }),
    run({ launchKey: 'DEV-1392', mintedBranch: 'DEV-1392-a' }),
    run({ launchKey: 'DEV-2', mintedBranch: 'DEV-2-a' }),
  ]
  const evidence = new Map([
    ['DEV-1392-a', { state: 'landed', landedBy: { type: 'patch-equivalent', form: 'squash' } }],
    [
      'DEV-1392-b',
      {
        state: 'landed',
        landedBy: {
          type: 'recorded',
          number: 42,
          mergeCommit: 'merged',
          mergedAt: '2026-10-18T01:00:00Z',
        },
      },
    ],
  ] as const)
  const localBranches = new Set(['DEV-1392-a', 'DEV-1392-b'])
  expect(decideTaskBranchesToPrune('DEV-1392', runs, localBranches, evidence)).toEqual({
    delete: ['DEV-1392-a', 'DEV-1392-b'],
    landingProof: ['DEV-1392-a', 'DEV-1392-b'],
    keep: [],
    gone: [],
  })
  expect(decideTaskBranchesToPrune('DEV-1392', runs, localBranches, new Map())).toEqual({
    delete: [],
    landingProof: [],
    keep: [
      { branch: 'DEV-1392-a', reason: 'landing not proved' },
      { branch: 'DEV-1392-b', reason: 'landing not proved' },
    ],
    gone: [],
  })
  expect(
    decideTaskBranchesToPrune(
      'DEV-1392',
      runs,
      localBranches,
      new Map([
        ['DEV-1392-a', { state: 'landed', landedBy: { type: 'contained', branch: 'DEV-1392-b' } }],
      ]),
    ),
  ).toEqual({
    delete: ['DEV-1392-a'],
    landingProof: ['DEV-1392-a'],
    keep: [{ branch: 'DEV-1392-b', reason: 'landing not proved' }],
    gone: [],
  })
  expect(decideTaskBranchesToPrune('DEV-1392', runs, new Set(), new Map())).toEqual({
    delete: [],
    landingProof: [],
    keep: [],
    gone: ['DEV-1392-a', 'DEV-1392-b'],
  })
  expect(decideTaskBranchesToPrune('DEV-1392', runs, new Set(), evidence)).toEqual({
    delete: [],
    landingProof: ['DEV-1392-a', 'DEV-1392-b'],
    keep: [],
    gone: [],
  })
  const goneLanded = decideTaskBranchesToPrune('DEV-1392', [runs[0]!], new Set(), evidence)
  const goneLandedRun = { ...runs[0]!, branch: 'DEV-1392-a' }
  expect(
    decideShipCleanup('DEV-1392', new Set(goneLanded.landingProof), '2026-10-18T01:00:00Z', [
      goneLandedRun,
    ])[0],
  ).toMatchObject({ scope: 'chain', artifacts: 'remove', worktreeAction: 'close' })
})
