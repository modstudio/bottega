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
}
const commandExit: Floor = { ...ruling, kind: 'command-exit' }
const artifact: Floor = { ...ruling, kind: 'recorded-artifact' }
const tracker: Floor = {
  ...ruling,
  kind: 'tracker-transition',
  requirePullRequest: true,
}
const deferrableExit: Floor = { ...commandExit, deferrable: true }

const answeredRuling: ValidatedEvidence = {
  ruling: { id: 9, answered: true, boundToCursor: true, boundToStep: true },
}
const gradedReview: ValidatedEvidence = {
  review: { id: 4, allFindingsDisposed: true, allLensesGraded: true },
}
const passingGate: ValidatedEvidence = { gate: { id: 2, finished: true, exitCode: 0 } }
const passingRun: ValidatedEvidence = { run: { id: 8, terminal: true, exitCode: 0 } }
const presentArtifact: ValidatedEvidence = { artifact: { ref: 'probe:3', exists: true } }
const closedTask: ValidatedEvidence = {
  task: { key: 'DEV-977', status: 'done', mergedPullRequest: true },
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

test('an unbound or unanswered ruling does not satisfy', () => {
  expect(
    decide({
      floors: [ruling],
      evidence: { ruling: { id: 9, answered: true, boundToCursor: true, boundToStep: false } },
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

test('a terminal run with the expected exit satisfies command-exit', () => {
  expect(decide({ floors: [commandExit], evidence: passingRun })).toMatchObject({
    action: 'allow',
    refs: [{ flag: '--run', value: '8' }],
  })
})

test('a non-zero gate fails unless the floor states otherwise', () => {
  expect(
    decide({
      floors: [commandExit],
      evidence: { gate: { id: 2, finished: true, exitCode: 1 } },
    }).action,
  ).toBe('refuse')
  expect(
    decide({
      floors: [{ ...commandExit, expectedExitCode: 1 }],
      evidence: { gate: { id: 2, finished: true, exitCode: 1 } },
    }).action,
  ).toBe('allow')
})

test('a recorded artifact satisfies that floor', () => {
  expect(decide({ floors: [artifact], evidence: presentArtifact })).toMatchObject({
    action: 'allow',
    refs: [{ flag: '--artifact', value: 'probe:3' }],
  })
})

test('tracker-transition requires the stated status and a merged pull request when asked', () => {
  expect(decide({ floors: [tracker], evidence: closedTask }).action).toBe('allow')
  expect(
    decide({
      floors: [tracker],
      evidence: { task: { key: 'DEV-977', status: 'done', mergedPullRequest: false } },
    }).action,
  ).toBe('refuse')
  expect(
    decide({
      floors: [{ ...tracker, requirePullRequest: false }],
      evidence: { task: { key: 'DEV-977', status: 'done', mergedPullRequest: false } },
    }).action,
  ).toBe('allow')
  expect(
    decide({
      floors: [tracker],
      evidence: { task: { key: 'DEV-977', status: 'active', mergedPullRequest: true } },
    }).action,
  ).toBe('refuse')
})

test('start closes on the active tracker state without a pull request', () => {
  expect(
    decide({
      floors: [{ ...tracker, expectedStatus: 'active', requirePullRequest: false }],
      evidence: { task: { key: 'DEV-977', status: 'active', mergedPullRequest: false } },
    }),
  ).toMatchObject({ action: 'allow' })
})

test('close refuses without a merged pull request', () => {
  expect(
    decide({
      floors: [{ ...tracker, expectedStatus: 'done', requirePullRequest: true }],
      evidence: { task: { key: 'DEV-977', status: 'done', mergedPullRequest: false } },
    }),
  ).toMatchObject({ action: 'refuse' })
})

test('a done task does not satisfy start', () => {
  expect(
    decide({
      floors: [{ ...tracker, expectedStatus: 'active', requirePullRequest: false }],
      evidence: { task: { key: 'DEV-977', status: 'done', mergedPullRequest: false } },
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
    id: 4,
  })
  expect(parseArtifactRef('probe:12')).toEqual({ kind: 'probe', id: 12 })
  expect(parseArtifactRef('doc:3')).toEqual({ kind: 'doc', id: 3 })
  expect(parseArtifactRef('run:8')).toEqual({ kind: 'run', id: 8 })
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
