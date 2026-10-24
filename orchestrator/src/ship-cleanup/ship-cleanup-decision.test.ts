import { describe, expect, test } from 'bun:test'
import {
  decideShipCleanup,
  decideShipCleanupKeptItem,
  decideShipCleanupVerdict,
  decideTaskBranchesToPrune,
  type ShipCleanupRunFact,
} from './ship-cleanup-decision.ts'

const run = (overrides: Partial<ShipCleanupRunFact> = {}): ShipCleanupRunFact => ({
  record_id: '1',
  number: 1,
  root_record_id: '1',
  rootNumber: 1,
  startedAt: '2026-10-18T00:00:00Z',
  job: 'implement',
  status: 'ok',
  branch: 'DEV-1392-c3',
  mintedBranch: 'DEV-1392-c3',
  launchKey: 'DEV-1392',
  judged: true,
  failureKind: null,
  rootFailureKind: null,
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

  test.each([
    [
      'unjudged billing run',
      { judged: false, failureKind: 'billing' },
      {
        artifacts: 'remove',
        worktreeAction: 'close',
        reason: 'provider did not serve the run (billing); nothing to judge',
      },
    ],
    [
      'unjudged truncated run',
      { judged: false, failureKind: 'truncated' },
      {
        artifacts: 'keep',
        worktreeAction: 'close',
        reason: 'run has no recorded verdict',
      },
    ],
  ] as const)('handles a terminal %s', (_case, overrides, expected) => {
    expect(decide([run(overrides)])[0]).toMatchObject(expected)
  })

  test.each([
    ['unevidenced', 'void'],
    ['other', 'score'],
  ] as const)('names one root remedy for an unjudged %s chain', (failureKind, remedy) => {
    const decisions = decide([
      run({
        record_id: 'root',
        number: 41,
        root_record_id: 'root',
        rootNumber: 41,
        judged: false,
        rootFailureKind: failureKind,
      }),
      run({
        record_id: 'turn',
        number: 42,
        root_record_id: 'root',
        rootNumber: 41,
        judged: false,
        rootFailureKind: failureKind,
      }),
    ])

    expect(
      decisions.flatMap((decision) =>
        decision.remedy ? [{ remedy: decision.remedy, rootNumber: decision.rootNumber }] : [],
      ),
    ).toEqual([{ remedy, rootNumber: 41 }])
  })

  test('skips a live run', () => {
    expect(decide([run({ status: 'asking' })])[0]).toMatchObject({
      artifacts: 'keep',
      worktreeAction: 'keep',
      reason: 'run is live (asking)',
    })
  })

  test('keeps a provider-unserved root while a continuation turn is live', () => {
    const decisions = decide([
      run({
        record_id: 'root',
        number: 41,
        root_record_id: 'root',
        rootNumber: 41,
        judged: false,
        failureKind: 'billing',
      }),
      run({
        record_id: 'turn',
        number: 42,
        root_record_id: 'root',
        rootNumber: 41,
        status: 'running',
        startedAt: '2026-10-18T02:00:00Z',
      }),
    ])

    expect(decisions[0]).toMatchObject({
      scope: 'chain',
      artifacts: 'keep',
      worktreeAction: 'keep',
      reason: 'run 42 is live (running)',
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

test('cleanup verdict excludes only items owned by the caller landing tree', () => {
  expect(decideShipCleanupVerdict({ kept: [], errors: [] })).toEqual({ clean: true, residue: [] })
  const selfTree = {
    item: 'run 7 worktree',
    reason: 'the command runs from this tree',
    reasonKind: 'command-tree' as const,
    owner: 'caller-landing-tree' as const,
  }
  const selfBranch = {
    item: 'branch DEV-1392-c3',
    reason: 'checked-out',
    reasonKind: 'safety-hold' as const,
    owner: 'caller-landing-tree' as const,
  }
  const foreignTree = {
    item: 'run 8 worktree',
    reason: 'held by another session',
    reasonKind: 'safety-hold' as const,
    owner: 'other' as const,
  }
  expect(decideShipCleanupVerdict({ kept: [selfTree, selfBranch], errors: [] })).toEqual({
    clean: true,
    residue: [],
  })
  expect(decideShipCleanupVerdict({ kept: [foreignTree], errors: [] })).toEqual({
    clean: false,
    reason: 'unexpected-kept-item',
    residue: [foreignTree],
  })
  expect(
    decideShipCleanupVerdict({ kept: [selfTree, foreignTree, selfBranch], errors: [] }),
  ).toEqual({
    clean: false,
    reason: 'unexpected-kept-item',
    residue: [foreignTree],
  })
  expect(decideShipCleanupVerdict({ kept: [], errors: [{}] })).toEqual({
    clean: false,
    reason: 'errors',
    residue: [],
  })
})

test('kept-item ownership requires the holding path to match the caller landing tree', () => {
  const fact = {
    item: 'branch DEV-1392-c3',
    reason: 'checked-out',
    reasonKind: 'safety-hold' as const,
  }
  expect(
    decideShipCleanupKeptItem({ ...fact, holdingPath: '/trees/landing' }, '/trees/landing'),
  ).toEqual({ ...fact, owner: 'caller-landing-tree' })
  expect(
    decideShipCleanupKeptItem({ ...fact, holdingPath: '/trees/sibling' }, '/trees/landing'),
  ).toEqual({ ...fact, owner: 'other' })
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
