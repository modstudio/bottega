import { expect, test } from 'bun:test'
import {
  catalogueFloors,
  decideFloorSatisfaction,
  type Floor,
  type FloorSatisfactionInput,
  type OpenObligation,
  parseArtifactRef,
  type ValidatedEvidence,
} from './workflow-floor.ts'

const ruling: Floor = {
  kind: 'ruling',
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: false,
}
const commandExit: Floor = { ...ruling, kind: 'command-exit' }
const artifact: Floor = { ...ruling, kind: 'recorded-artifact' }
const tracker: Floor = {
  ...ruling,
  kind: 'tracker-transition',
  requirePullRequest: true,
}
const operatorRuling: Floor = { ...ruling, operatorRuling: true }
const deferrableExit: Floor = { ...commandExit, deferrable: true }

const answeredRuling: ValidatedEvidence = {
  ruling: {
    id: 9,
    answered: true,
    answeredByOperator: false,
    boundToCursor: true,
    boundToStep: true,
  },
}
const gradedReview: ValidatedEvidence = {
  review: { id: 4, allFindingsDisposed: true, allLensesGraded: true },
}
const passingGate: ValidatedEvidence = {
  gate: { id: 2, finished: true, exitCode: 0, project: 'fixture', commit: 'abc' },
  tree: { project: 'fixture', commit: 'abc' },
}
const passingRun: ValidatedEvidence = { run: { id: 8, terminal: true, exitCode: 0 } }
const passingProbe: ValidatedEvidence = { probe: { id: 3, exitCode: 0 } }
const passingExec: ValidatedEvidence = {
  exec: {
    id: 4,
    exitCode: 0,
    sessionMatches: true,
    sessionAdoptedCursor: false,
    createdAfterStepActivation: true,
  },
}
const presentArtifact: ValidatedEvidence = { artifact: { ref: 'probe:3', exists: true } }
const closedTask: ValidatedEvidence = {
  task: {
    key: 'DEV-977',
    status: 'done',
    statusCategory: 'closed',
    mergedPullRequest: true,
    trackerStates: {},
  },
}

const decide = (input: Partial<FloorSatisfactionInput> & Pick<FloorSatisfactionInput, 'floors'>) =>
  decideFloorSatisfaction({
    evidence: {},
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
    ...input,
  })

test('note-only enforcement closes without evidence', () => {
  expect(decide({ floors: [ruling], enforcement: 'note-only' })).toEqual({
    action: 'allow',
    enforcement: 'note-only',
    refs: [],
  })
})

test('a bound answered ruling satisfies a ruling floor', () => {
  expect(decide({ floors: [ruling], evidence: answeredRuling })).toMatchObject({
    action: 'allow',
    refs: [{ flag: '--ruling', value: '9' }],
  })
})

test('a fully triaged graded review satisfies a ruling floor', () => {
  expect(decide({ floors: [ruling], evidence: gradedReview })).toMatchObject({
    action: 'allow',
    refs: [{ flag: '--review', value: '4' }],
  })
})

test('an operator ruling floor requires a bound operator answer', () => {
  const agentAnswer = answeredRuling
  const operatorAnswer: ValidatedEvidence = {
    ruling: { ...answeredRuling.ruling!, answeredByOperator: true },
  }

  const reviewCategoryTask: ValidatedEvidence = {
    task: {
      key: 'DEV-1',
      status: 'blocked',
      statusCategory: 'review',
      mergedPullRequest: true,
      trackerStates: {},
    },
  }

  for (const evidence of [{}, agentAnswer, gradedReview, reviewCategoryTask]) {
    const decision = decide({ floors: [operatorRuling], evidence })
    expect(decision.action).toBe('refuse')
    if (decision.action === 'refuse') {
      expect(decision.message).toContain('no operator answer on this step')
      expect(decision.message).toContain('orch workflow await')
    }
  }
  expect(decide({ floors: [operatorRuling], evidence: operatorAnswer })).toMatchObject({
    action: 'allow',
    refs: [{ flag: '--ruling', value: '9' }],
  })
})

test('an agent ruling is refused when task evidence also meets an alternative floor', () => {
  const decision = decide({
    floors: [artifact, operatorRuling],
    evidence: { ...presentArtifact, ...answeredRuling },
  })
  expect(decision).toEqual({
    action: 'refuse',
    message:
      'floor ruling is unmet: no operator answer on this step; the supplied ruling cannot close it; record the question with `orch workflow await`; the operator answers it',
  })
})

test('an unbound or unanswered ruling does not satisfy', () => {
  expect(
    decide({
      floors: [ruling],
      evidence: {
        ruling: {
          id: 9,
          answered: true,
          answeredByOperator: false,
          boundToCursor: true,
          boundToStep: false,
        },
      },
    }).action,
  ).toBe('refuse')
  expect(decide({ floors: [ruling] }).action).toBe('refuse')
})

test('a finished gate with the expected exit satisfies command-exit', () => {
  expect(decide({ floors: [commandExit], evidence: passingGate })).toMatchObject({
    action: 'allow',
    refs: [{ flag: '--gate', value: '2' }],
  })
})

test.each([
  ['matching commit and zero exit', passingGate, true],
  ['another commit', { ...passingGate, gate: { ...passingGate.gate!, commit: 'def' } }, false],
  ['nonzero exit', { ...passingGate, gate: { ...passingGate.gate!, exitCode: 1 } }, false],
  [
    "another project's record",
    { ...passingGate, gate: { ...passingGate.gate!, project: 'other' } },
    false,
  ],
  [
    'unknown gate and tree commits',
    {
      gate: { ...passingGate.gate!, commit: null },
      tree: { ...passingGate.tree!, commit: null },
    },
    false,
  ],
  ['an exec artifact', { ...passingExec, tree: passingGate.tree }, false],
] as const)('gate-only command evidence: %s', (_case, evidence, allowed) => {
  const decision = decide({ floors: [{ ...commandExit, commandEvidence: 'gate' }], evidence })
  expect(decision.action).toBe(allowed ? 'allow' : 'refuse')
  if (!allowed && decision.action === 'refuse') {
    expect(decision.message).toContain(`commit ${evidence.tree?.commit ?? '<current tree commit>'}`)
    expect(decision.message).toContain('orch gate run')
  }
})

test('a terminal run with the expected exit satisfies command-exit', () => {
  expect(decide({ floors: [commandExit], evidence: passingRun })).toMatchObject({
    action: 'allow',
    refs: [{ flag: '--run', value: '8' }],
  })
})

test('a probe with the expected exit satisfies command-exit', () => {
  expect(decide({ floors: [commandExit], evidence: passingProbe }).action).toBe('allow')
  expect(
    decide({ floors: [commandExit], evidence: { probe: { id: 3, exitCode: 1 } } }).action,
  ).toBe('refuse')
})

test('an exec with the expected exit satisfies command-exit', () => {
  expect(decide({ floors: [commandExit], evidence: passingExec }).action).toBe('allow')
  expect(
    decide({
      floors: [commandExit],
      evidence: {
        exec: {
          id: 4,
          exitCode: 1,
          sessionMatches: true,
          sessionAdoptedCursor: false,
          createdAfterStepActivation: true,
        },
      },
    }).action,
  ).toBe('refuse')
})

test('an exec from another session is refused with the rerun remedy', () => {
  const decision = decide({
    floors: [commandExit],
    evidence: {
      exec: {
        id: 4,
        exitCode: 0,
        sessionMatches: false,
        sessionAdoptedCursor: false,
        createdAfterStepActivation: true,
      },
    },
  })
  expect(decision).toEqual({
    action: 'refuse',
    message:
      'command-exit evidence exec:4 belongs to another session; run the command again with `orch workflow exec -- <command>` in this session after the step started',
  })
})

test("an adopting session's exec satisfies command-exit", () => {
  expect(
    decide({
      floors: [commandExit],
      evidence: {
        exec: {
          id: 4,
          exitCode: 0,
          sessionMatches: false,
          sessionAdoptedCursor: true,
          createdAfterStepActivation: true,
        },
      },
    }).action,
  ).toBe('allow')
})

test('an exec older than the active step is refused with the rerun remedy', () => {
  const decision = decide({
    floors: [commandExit],
    evidence: {
      exec: {
        id: 4,
        exitCode: 0,
        sessionMatches: true,
        sessionAdoptedCursor: false,
        createdAfterStepActivation: false,
      },
    },
  })
  expect(decision).toEqual({
    action: 'refuse',
    message:
      'command-exit evidence exec:4 predates this step becoming active; run the command again with `orch workflow exec -- <command>` in this session after the step started',
  })
})

test('a non-zero gate fails unless the floor states otherwise', () => {
  expect(
    decide({
      floors: [commandExit],
      evidence: {
        gate: { id: 2, finished: true, exitCode: 1, project: null, commit: null },
      },
    }).action,
  ).toBe('refuse')
  expect(
    decide({
      floors: [{ ...commandExit, expectedExitCode: 1 }],
      evidence: {
        gate: { id: 2, finished: true, exitCode: 1, project: null, commit: null },
      },
    }).action,
  ).toBe('allow')
})

test('a recorded artifact satisfies that floor', () => {
  expect(decide({ floors: [artifact], evidence: presentArtifact })).toMatchObject({
    action: 'allow',
    refs: [{ flag: '--artifact', value: 'probe:3' }],
  })
})

test('tracker-transition accepts a raw status match', () => {
  expect(decide({ floors: [tracker], evidence: closedTask }).action).toBe('allow')
})

test('tracker-transition accepts a category match and requires a merged pull request when asked', () => {
  expect(
    decide({
      floors: [tracker],
      evidence: {
        task: {
          key: 'DEV-977',
          status: 'complete',
          statusCategory: 'done',
          mergedPullRequest: false,
          trackerStates: {},
        },
      },
    }).action,
  ).toBe('refuse')
  expect(
    decide({
      floors: [{ ...tracker, requirePullRequest: false }],
      evidence: {
        task: {
          key: 'DEV-977',
          status: 'complete',
          statusCategory: 'done',
          mergedPullRequest: false,
          trackerStates: {},
        },
      },
    }).action,
  ).toBe('allow')
  const refused = decide({
    floors: [tracker],
    evidence: {
      task: {
        key: 'ADN-1039',
        status: 'in_progress',
        statusCategory: 'active',
        mergedPullRequest: true,
        trackerStates: {},
      },
    },
  })
  expect(refused).toMatchObject({ action: 'refuse' })
  if (refused.action === 'refuse')
    expect(refused.message).toContain(
      'ADN-1039 reads back as in_progress (category active); expected done',
    )
})

const starshipStates = {
  backlog: 'backlog',
  unstarted: 'open',
  started: 'active',
  completed: 'done',
  canceled: 'dropped',
  'In Review': 'review',
} as const
const normalizedStates = { in_review: 'review', queued: 'backlog' } as const

test.each([
  ['active by mapped category', 'In Progress', 'active', 'started', starshipStates],
  ['done by mapped category', 'Done', 'done', 'completed', starshipStates],
  ['review by status name', 'In Review', 'review', 'In Review', starshipStates],
  ['hub tracker by category', 'in_progress', 'active', 'active', {}],
  ['a normalized mapped word', 'Review', 'review', 'IN-REVIEW', normalizedStates],
  ['a backlog mapping normalized to open', 'Todo', 'open', 'queued', normalizedStates],
] as const)(
  'tracker-transition accepts %s',
  (_case, status, statusCategory, expectedStatus, trackerStates) => {
    expect(
      decide({
        floors: [{ ...tracker, expectedStatus, requirePullRequest: false }],
        evidence: {
          task: {
            key: 'STAR-4291',
            status,
            statusCategory,
            mergedPullRequest: false,
            trackerStates,
          },
        },
      }),
    ).toMatchObject({ action: 'allow' })
  },
)

test.each([
  [
    'a mapped tracker word',
    'started',
    starshipStates,
    'floor tracker-transition is unmet; pass --task <KEY>; STAR-4291 reads back as Todo (category open); expected started (category active)',
  ],
  [
    'an unmapped tracker word',
    'triaged',
    starshipStates,
    'floor tracker-transition is unmet; pass --task <KEY>; STAR-4291 reads back as Todo (category open); expected triaged',
  ],
] as const)(
  'tracker-transition refuses %s with the compared expectation',
  (_case, expectedStatus, trackerStates, message) => {
    expect(
      decide({
        floors: [{ ...tracker, expectedStatus, requirePullRequest: false }],
        evidence: {
          task: {
            key: 'STAR-4291',
            status: 'Todo',
            statusCategory: 'open',
            mergedPullRequest: false,
            trackerStates,
          },
        },
      }),
    ).toEqual({ action: 'refuse', message })
  },
)

test('tracker-transition still requires a merged pull request after a mapped category match', () => {
  expect(
    decide({
      floors: [{ ...tracker, expectedStatus: 'completed', requirePullRequest: true }],
      evidence: {
        task: {
          key: 'STAR-4291',
          status: 'Done',
          statusCategory: 'done',
          mergedPullRequest: false,
          trackerStates: starshipStates,
        },
      },
    }),
  ).toMatchObject({ action: 'refuse' })
})

test('start closes on the active tracker state without a pull request', () => {
  expect(
    decide({
      floors: [{ ...tracker, expectedStatus: 'active', requirePullRequest: false }],
      evidence: {
        task: {
          key: 'DEV-977',
          status: 'in_progress',
          statusCategory: 'active',
          mergedPullRequest: false,
          trackerStates: {},
        },
      },
    }),
  ).toMatchObject({ action: 'allow' })
})

test('close refuses without a merged pull request', () => {
  expect(
    decide({
      floors: [{ ...tracker, expectedStatus: 'done', requirePullRequest: true }],
      evidence: {
        task: {
          key: 'DEV-977',
          status: 'done',
          statusCategory: 'done',
          mergedPullRequest: false,
          trackerStates: {},
        },
      },
    }),
  ).toMatchObject({ action: 'refuse' })
})

test('a done task does not satisfy start', () => {
  expect(
    decide({
      floors: [{ ...tracker, expectedStatus: 'active', requirePullRequest: false }],
      evidence: {
        task: {
          key: 'DEV-977',
          status: 'done',
          statusCategory: 'done',
          mergedPullRequest: false,
          trackerStates: {},
        },
      },
    }),
  ).toMatchObject({ action: 'refuse' })
})

test('alternative floors close when any one is met', () => {
  expect(decide({ floors: [commandExit, artifact], evidence: presentArtifact }).action).toBe(
    'allow',
  )
  expect(decide({ floors: [commandExit, artifact], evidence: passingGate }).action).toBe('allow')
  expect(decide({ floors: [commandExit, artifact] }).action).toBe('refuse')
})

test('deferral closes a deferrable floor without evidence and records the floor', () => {
  expect(
    decide({ floors: [deferrableExit], evidence: { deferReason: 'merge after landing' } }),
  ).toEqual({
    action: 'allow',
    enforcement: 'floors',
    refs: [],
    defer: { floor: 'command-exit', reason: 'merge after landing' },
  })
})

test('a step whose floors are not deferrable cannot use --defer', () => {
  const decision = decide({ floors: [commandExit], evidence: { deferReason: 'later' } })
  expect(decision.action).toBe('refuse')
  if (decision.action === 'refuse') expect(decision.message).toContain('--gate')
})

test('evidence wins over an unused deferral', () => {
  expect(
    decide({
      floors: [deferrableExit],
      evidence: { ...passingGate, deferReason: 'unused' },
    }),
  ).toEqual({
    action: 'allow',
    enforcement: 'floors',
    refs: [{ flag: '--gate', value: '2' }],
  })
})

test('satisfying an open obligation requires evidence for that floor', () => {
  const obligationFloor = { ...commandExit, deferrable: true }
  expect(
    decide({
      floors: [artifact],
      evidence: {
        ...presentArtifact,
        ...passingGate,
        satisfy: {
          id: 11,
          found: true,
          open: true,
          abandoned: false,
          cursorMatches: true,
          floor: obligationFloor,
        },
      },
    }),
  ).toMatchObject({ action: 'allow', satisfyId: 11 })
  expect(
    decide({
      floors: [artifact],
      evidence: {
        ...presentArtifact,
        satisfy: {
          id: 11,
          found: true,
          open: true,
          abandoned: false,
          cursorMatches: true,
          floor: obligationFloor,
        },
      },
    }).action,
  ).toBe('refuse')
})

test('finish refuses while any obligation would remain open', () => {
  const open: OpenObligation[] = [
    { id: 11, stepOrdinal: 2, stepSlug: 'merge', floor: 'command-exit' },
  ]
  const decision = decide({
    floors: [artifact],
    evidence: presentArtifact,
    finishing: true,
    openObligations: open,
  })
  expect(decision.action).toBe('refuse')
  if (decision.action === 'refuse') {
    expect(decision.message).toContain('obligation 11')
    expect(decision.message).toContain('--satisfies 11')
    expect(decision.message).toContain('--gate')
  }
})

test('finish refuses a deferral of the last step', () => {
  const decision = decide({
    floors: [deferrableExit],
    evidence: { deferReason: 'later' },
    finishing: true,
  })
  expect(decision.action).toBe('refuse')
  if (decision.action === 'refuse') expect(decision.message).toContain('--defer')
})

test('finish proceeds when the last open obligation is satisfied', () => {
  expect(
    decide({
      floors: [commandExit],
      evidence: {
        ...passingGate,
        satisfy: {
          id: 11,
          found: true,
          open: true,
          abandoned: false,
          cursorMatches: true,
          floor: deferrableExit,
        },
      },
      finishing: true,
      openObligations: [{ id: 11, stepOrdinal: 2, stepSlug: 'merge', floor: 'command-exit' }],
    }).action,
  ).toBe('allow')
})

test('refusals name the floor and the flag', () => {
  const decision = decide({ floors: [ruling, commandExit] })
  expect(decision.action).toBe('refuse')
  if (decision.action === 'refuse') {
    expect(decision.message).toContain('floor ruling')
    expect(decision.message).toContain('--ruling')
    expect(decision.message).toContain('floor command-exit')
    expect(decision.message).toContain('--gate')
  }
})

test('parseArtifactRef accepts each recorded-artifact form', () => {
  expect(parseArtifactRef('task:DEV-977#comment:4')).toEqual({
    kind: 'comment',
    key: 'DEV-977',
    id: '4',
  })
  expect(parseArtifactRef('task:DEV-977#comment:01a10c8d-164d-71e9-b8a9-a59f15256556')).toEqual({
    kind: 'comment',
    key: 'DEV-977',
    id: '01a10c8d-164d-71e9-b8a9-a59f15256556',
  })
  expect(parseArtifactRef('task:DEV-977')).toEqual({ kind: 'task', key: 'DEV-977' })
  expect(parseArtifactRef('probe:12')).toEqual({ kind: 'probe', id: 12 })
  expect(parseArtifactRef('exec:13')).toEqual({ kind: 'exec', id: 13 })
  expect(parseArtifactRef('doc:3')).toEqual({ kind: 'doc', id: 3 })
  expect(parseArtifactRef('run:8')).toEqual({ kind: 'run', id: 8 })
  expect(parseArtifactRef('attached-text:14')).toEqual({ kind: 'attached-text', id: 14 })
  expect(parseArtifactRef('8')).toEqual({ kind: 'id', id: 8 })
  expect(parseArtifactRef('nope')).toMatchObject({ error: expect.stringContaining('--artifact') })
})

test('catalogueFloors marks deferrable kinds and pull-request tracker floors', () => {
  expect(catalogueFloors(['command-exit', 'recorded-artifact'], ['command-exit'])).toEqual([
    { ...commandExit, deferrable: true },
    artifact,
  ])
  expect(catalogueFloors(['tracker-transition'], [], 'active', true)[0]).toMatchObject({
    expectedStatus: 'active',
    requirePullRequest: true,
  })
  expect(catalogueFloors(['ruling'], [], 'done', false, true)[0]).toMatchObject({
    operatorRuling: true,
  })
  expect(catalogueFloors(['command-exit'], [], 'done', false, false, 'gate')[0]).toMatchObject({
    commandEvidence: 'gate',
  })
})

test('catalogueFloors refuses an unknown kind', () => {
  expect(() => catalogueFloors(['not-a-floor'])).toThrow('unknown floor kind "not-a-floor"')
})

test('a missing obligation is refused without a fabricated floor', () => {
  const decision = decide({
    floors: [artifact],
    evidence: { ...presentArtifact, satisfy: { id: 99, found: false } },
  })
  expect(decision.action).toBe('refuse')
  if (decision.action === 'refuse')
    expect(decision.message).toContain('obligation 99 does not exist')
})
