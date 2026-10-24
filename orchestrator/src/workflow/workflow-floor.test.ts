import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

const OBLIGATION_UUID = '00000000-0000-4000-8000-000000000011'
const MISSING_OBLIGATION_UUID = '00000000-0000-4000-8000-000000000099'
const ATTACHMENT_UUID = '00000000-0000-4000-8000-000000000014'

import {
  catalogueFloors,
  decideCloseFloors,
  decideFloorSatisfaction,
  decidePullRequestEvidence,
  type Floor,
  type FloorSatisfactionInput,
  mayCloseOnAgentSelfRuling,
  type OpenObligation,
  parseArtifactRef,
  reentryBoundRefusal,
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
const pullRequestExit: Floor = { ...commandExit, commandEvidence: 'pull-request' }
const pullRequestArtifact: Floor = { ...artifact, commandEvidence: 'pull-request' }
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
  review: { recordId: 'review-4', number: 4, allFindingsDisposed: true, allLensesGraded: true },
}
const passingGate: ValidatedEvidence = {
  gate: {
    recordId: '00000000-0000-4000-8000-000000000002',
    finished: true,
    exitCode: 0,
    project: 'fixture',
    commit: 'abc',
  },
  tree: { project: 'fixture', commit: 'abc' },
}
const passingRun: ValidatedEvidence = { run: { id: '8', terminal: true, exitCode: 0 } }
const passingProbe: ValidatedEvidence = { probe: { id: 3, exitCode: 0 } }
const EXEC_RECORD_ID = '00000000-0000-4000-8000-000000000004'
const passingExec: ValidatedEvidence = {
  exec: {
    id: 4,
    recordId: EXEC_RECORD_ID,
    command: 'true',
    argv: ['true'],
    exitCode: 0,
    sessionMatches: true,
    sessionAdoptedCursor: false,
    createdAfterStepActivation: true,
    checkoutBranch: 'DEV-977-work',
    headCommit: 'abc',
    cursorBranch: 'DEV-977-work',
    output: '',
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

test('a ruling outcome replaces ordinary floors with a ruling floor', () => {
  const step = {
    floor: ['recorded-artifact'] as const,
    rulingOutcomes: ['fix'],
    operatorRuling: false,
  }
  expect(decideCloseFloors(step, 'fix').map((floor) => floor.kind)).toEqual(['ruling'])
  expect(decideCloseFloors(step, 'clear').map((floor) => floor.kind)).toEqual(['recorded-artifact'])
  expect(decideCloseFloors(step, 'clear', true).map((floor) => floor.kind)).toEqual(['ruling'])
  expect(mayCloseOnAgentSelfRuling(step, 'fix')).toBe(true)
  expect(mayCloseOnAgentSelfRuling(step, 'clear')).toBe(false)
  expect(mayCloseOnAgentSelfRuling(step, 'clear', true)).toBe(true)
  expect(mayCloseOnAgentSelfRuling({ ...step, operatorRuling: true }, 'fix')).toBe(false)
})

test('an outcome-specific exit code replaces the command-exit default for that close', () => {
  const step = {
    floor: ['command-exit', 'recorded-artifact'] as const,
    expectedExitCodes: { merged: 0, 'merged-with-residue': 20 },
  }
  expect(decideCloseFloors(step, 'merged')[0]?.expectedExitCode).toBe(0)
  expect(decideCloseFloors(step, 'merged-with-residue')[0]?.expectedExitCode).toBe(20)
  expect(decideCloseFloors(step, undefined)[0]?.expectedExitCode).toBe(0)
})

test('the re-entry bound refusal names await and a non-re-entering outcome', () => {
  expect(reentryBoundRefusal('changed', ['changed', 'clean'])).toContain(
    `${PLATFORM_SLUG} workflow await`,
  )
  expect(reentryBoundRefusal('changed', ['changed', 'clean'])).toContain(
    'close with a non-re-entering outcome (clean)',
  )
})

test('a re-entry bound accepts only a ruling answered after the last re-entry', () => {
  const after = '2026-10-20T12:00:00.000Z'
  const bound = (answeredAt: string | null): ValidatedEvidence => ({
    ruling: {
      id: 9,
      answered: true,
      answeredByOperator: false,
      boundToCursor: true,
      boundToStep: true,
      answeredAt,
    },
  })
  expect(
    decide({
      floors: [ruling],
      evidence: bound('2026-10-20T12:00:00.001Z'),
      freshRulingAfter: after,
    }),
  ).toMatchObject({ action: 'allow' })
  expect(decide({ floors: [ruling], evidence: bound(after), freshRulingAfter: after }).action).toBe(
    'refuse',
  )
  expect(
    decide({
      floors: [ruling],
      evidence: bound('2026-10-20T11:59:59.999Z'),
      freshRulingAfter: after,
    }).action,
  ).toBe('refuse')
  expect(decide({ floors: [ruling], evidence: gradedReview, freshRulingAfter: after }).action).toBe(
    'refuse',
  )
  expect(decide({ floors: [ruling], evidence: gradedReview }).action).toBe('allow')
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

test('an unfinished review round refusal names every unfinished review id', () => {
  expect(
    decide({
      floors: [ruling],
      evidence: {
        review: {
          recordId: 'review-4',
          number: 4,
          allFindingsDisposed: true,
          allLensesGraded: false,
          unfinishedReviewIds: [5, 7],
        },
      },
    }),
  ).toEqual({
    action: 'refuse',
    message: 'floor ruling is unmet: review ids 5, 7 in this round are unfinished',
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
      expect(decision.message).toContain(`${PLATFORM_SLUG} workflow await`)
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
    message: `floor ruling is unmet: no operator answer on this step; the supplied ruling cannot close it; record the question with \`${PLATFORM_SLUG} workflow await\`; the operator answers it`,
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
    refs: [{ flag: '--gate', value: '00000000-0000-4000-8000-000000000002' }],
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
    if (evidence.tree?.commit) {
      expect(decision.message).toContain(`commit ${evidence.tree.commit}`)
      expect(decision.message).toContain(`${PLATFORM_SLUG} gate run`)
    } else {
      expect(decision.message).toContain('no recorded worktree')
      expect(decision.message).toContain('--arg worktree=<tree>')
    }
  }
})

test('a terminal run with the expected exit satisfies command-exit', () => {
  expect(decide({ floors: [commandExit], evidence: passingRun })).toMatchObject({
    action: 'allow',
    refs: [{ flag: '--run', value: '8' }],
  })
})

test('a run offered to an artifact floor names the same run artifact form', () => {
  const decision = decide({
    floors: [artifact],
    evidence: { runOffered: 8, run: { id: '8', terminal: true, exitCode: 0 } },
  })
  expect(decision).toEqual({
    action: 'refuse',
    message:
      'floor recorded-artifact is unmet; pass --artifact <doc:<scope>/<subject-or-_>/<slug> | doc:<UUID> | task:<KEY> | task:<KEY>#comment:<id> | run number | probe:<id> | exec:<id> | attached-text:<UUID> | GitHub pull-request link>; run 8 is accepted as --artifact 8 when it has a reply or a recorded artifact',
  })
})

test('a run artifact offered to a command floor names the same run command form', () => {
  const decision = decide({
    floors: [commandExit],
    evidence: { artifactRunOffered: '8', artifact: { ref: '8', exists: true } },
  })
  expect(decision).toEqual({
    action: 'refuse',
    message:
      'floor command-exit is unmet; pass --gate <gate execution id> or --run <run id> or --artifact probe:<id> or --artifact exec:<id> with exit code 0; run 8 is accepted as --run 8 once terminal with exit code 0',
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
          ...passingExec.exec!,
          command: `${PLATFORM_SLUG} pr create`,
          exitCode: 1,
        },
      },
    }).action,
  ).toBe('refuse')
})

test('a failed exec cannot use the recorded-artifact alternative on a command-exit step', () => {
  expect(
    decide({
      floors: [commandExit, artifact],
      evidence: {
        artifact: { ref: `exec:${EXEC_RECORD_ID}`, exists: true },
        exec: {
          ...passingExec.exec!,
          command: `${PLATFORM_SLUG} pr create`,
          exitCode: 1,
        },
      },
    }),
  ).toEqual({
    action: 'refuse',
    message: `command-exit floor expects exit code 0, but evidence exec:4 command \`${PLATFORM_SLUG} pr create\` exited 1; close with the outcome configured for exit code 1, or record a command that exits 0 with \`${PLATFORM_SLUG} workflow exec -- <command>\` and pass the new exec id`,
  })
})

test('a passing gate wins over a failed exec recorded as an artifact', () => {
  expect(
    decide({
      floors: [commandExit, artifact],
      evidence: {
        ...passingGate,
        artifact: { ref: `exec:${EXEC_RECORD_ID}`, exists: true },
        exec: { ...passingExec.exec!, exitCode: 1 },
      },
    }).action,
  ).toBe('allow')
})

test('a passing terminal run wins over a failed exec recorded as an artifact', () => {
  expect(
    decide({
      floors: [commandExit, artifact],
      evidence: {
        ...passingRun,
        artifact: { ref: `exec:${EXEC_RECORD_ID}`, exists: true },
        exec: { ...passingExec.exec!, exitCode: 1 },
      },
    }).action,
  ).toBe('allow')
})

test('an incidental failed exec does not prevent deferral of command-exit', () => {
  expect(
    decide({
      floors: [deferrableExit],
      evidence: {
        deferReason: 'merge after landing',
        artifact: { ref: `exec:${EXEC_RECORD_ID}`, exists: true },
        exec: { ...passingExec.exec!, exitCode: 1 },
      },
    }),
  ).toMatchObject({
    action: 'allow',
    defer: { floor: 'command-exit', reason: 'merge after landing' },
  })
})

test('an exec matching a nonzero expected exit satisfies command-exit', () => {
  expect(
    decide({
      floors: [{ ...commandExit, expectedExitCode: 1 }, artifact],
      evidence: {
        artifact: { ref: `exec:${EXEC_RECORD_ID}`, exists: true },
        exec: { ...passingExec.exec!, exitCode: 1 },
      },
    }).action,
  ).toBe('allow')
})

test('a failed exec remains valid for a recorded-artifact-only step', () => {
  expect(
    decide({
      floors: [artifact],
      evidence: {
        artifact: { ref: `exec:${EXEC_RECORD_ID}`, exists: true },
        exec: {
          ...passingExec.exec!,
          command: `${PLATFORM_SLUG} pr create`,
          exitCode: 1,
        },
      },
    }).action,
  ).toBe('allow')
})

test('an exec from another session is refused with the rerun remedy', () => {
  const decision = decide({
    floors: [commandExit],
    evidence: {
      exec: {
        ...passingExec.exec!,
        sessionMatches: false,
        sessionAdoptedCursor: false,
      },
    },
  })
  expect(decision).toEqual({
    action: 'refuse',
    message: `command-exit evidence exec:4 belongs to another session; run the command again with \`${PLATFORM_SLUG} workflow exec -- <command>\` in this session after the step started`,
  })
})

test("an adopting session's exec satisfies command-exit", () => {
  expect(
    decide({
      floors: [commandExit],
      evidence: {
        exec: {
          ...passingExec.exec!,
          sessionMatches: false,
          sessionAdoptedCursor: true,
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
        ...passingExec.exec!,
        createdAfterStepActivation: false,
      },
    },
  })
  expect(decision).toEqual({
    action: 'refuse',
    message: `command-exit evidence exec:4 predates this step becoming active; run the command again with \`${PLATFORM_SLUG} workflow exec -- <command>\` in this session after the step started`,
  })
})

test('a recorded artifact satisfies that floor', () => {
  expect(decide({ floors: [artifact], evidence: presentArtifact })).toMatchObject({
    action: 'allow',
    refs: [{ flag: '--artifact', value: 'probe:3' }],
  })
})

test('pull-request evidence rejects generic artifacts and unrelated successful commands', () => {
  for (const evidence of [presentArtifact, passingExec, passingRun, passingProbe, passingGate])
    expect(
      decide({
        floors: [pullRequestExit, pullRequestArtifact],
        evidence,
      }).action,
    ).toBe('refuse')
})

test('pull-request evidence accepts a link with the cursor head and base', () => {
  expect(
    decide({
      floors: [pullRequestExit, pullRequestArtifact],
      evidence: {
        artifact: { ref: 'https://github.com/acme/app/pull/7', exists: true },
        pullRequest: {
          url: 'https://github.com/acme/app/pull/7',
          repository: 'acme/app',
          projectRepository: 'acme/app',
          state: 'OPEN',
          head: 'DEV-977-work',
          base: 'main',
          cursorBranch: 'DEV-977-work',
          trunk: 'main',
        },
      },
    }).action,
  ).toBe('allow')
  expect(
    decide({
      floors: [pullRequestExit, pullRequestArtifact],
      evidence: {
        artifact: { ref: 'https://github.com/acme/app/pull/7', exists: true },
        pullRequest: {
          url: 'https://github.com/acme/app/pull/7',
          repository: 'acme/app',
          projectRepository: 'acme/app',
          state: 'OPEN',
          head: 'DEV-977-work',
          base: 'wrong',
          cursorBranch: 'DEV-977-work',
          trunk: 'main',
        },
      },
    }).action,
  ).toBe('refuse')
})

test('pull-request evidence binds commands to the exact branch and links to the project repository and state', () => {
  const exec = {
    kind: 'exec' as const,
    argv: [PLATFORM_SLUG, 'pr', 'create'],
    exitCode: 0,
    sessionBound: true,
    createdAfterStepActivation: true,
    checkoutBranch: 'other-branch',
    headCommit: 'shared-commit',
    cursorBranch: 'DEV-977-work',
    output: '',
    outputWithheld: false,
  }
  expect(decidePullRequestEvidence(exec)).toEqual({
    met: false,
    condition:
      "the recorded command checkout branch is other-branch, not this cursor's DEV-977-work",
  })

  const link = {
    kind: 'link' as const,
    repository: 'foreign/app',
    projectRepository: 'acme/app',
    state: 'OPEN',
    head: 'DEV-977-work',
    base: 'main',
    cursorBranch: 'DEV-977-work',
    trunk: 'main',
  }
  expect(decidePullRequestEvidence(link)).toEqual({
    met: false,
    condition: "the pull request repository is foreign/app, not this project's acme/app",
  })
  expect(decidePullRequestEvidence({ ...link, repository: 'acme/app', state: 'CLOSED' })).toEqual({
    met: false,
    condition: 'the pull request state is CLOSED, not open or merged',
  })
  expect(decidePullRequestEvidence({ ...link, repository: 'acme/app', state: 'MERGED' })).toEqual({
    met: true,
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

test('tracker-transition requires the exact raw state only for a multi-state category', () => {
  const severalReviewStates = {
    waiting: 'review',
    reviewing: 'review',
  } as const
  const oneReviewState = { reviewing: 'review' } as const
  const evidence = (trackerStates: typeof severalReviewStates | typeof oneReviewState) => ({
    task: {
      key: 'DEV-1178',
      status: 'reviewing',
      statusCategory: 'review',
      mergedPullRequest: false,
      trackerStates,
    },
  })

  expect(
    decide({
      floors: [{ ...tracker, expectedStatus: 'waiting', requirePullRequest: false }],
      evidence: evidence(severalReviewStates),
    }).action,
  ).toBe('refuse')
  expect(
    decide({
      floors: [{ ...tracker, expectedStatus: 'reviewing', requirePullRequest: false }],
      evidence: evidence(severalReviewStates),
    }).action,
  ).toBe('allow')
  expect(
    decide({
      floors: [{ ...tracker, expectedStatus: 'reviewing', requirePullRequest: false }],
      evidence: {
        task: { ...evidence(oneReviewState).task, status: 'Review', trackerStates: oneReviewState },
      },
    }).action,
  ).toBe('allow')
})

test('a waiting floor accepts in-review while an in-review floor rejects waiting', () => {
  const trackerStates = { waiting: 'review', reviewing: 'review' } as const
  const task = (status: string): ValidatedEvidence => ({
    task: {
      key: 'DEV-1178',
      status,
      statusCategory: 'review',
      mergedPullRequest: false,
      trackerStates,
    },
  })
  const waitingFloors = catalogueFloors(['tracker-transition'], [], ['waiting', 'reviewing'])
  const inReviewFloors = catalogueFloors(['tracker-transition'], [], 'reviewing')

  expect(decide({ floors: waitingFloors, evidence: task('reviewing') }).action).toBe('allow')
  expect(decide({ floors: inReviewFloors, evidence: task('waiting') }).action).toBe('refuse')
})

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
    refs: [{ flag: '--gate', value: '00000000-0000-4000-8000-000000000002' }],
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
          id: OBLIGATION_UUID,
          found: true,
          open: true,
          abandoned: false,
          cursorMatches: true,
          floor: obligationFloor,
        },
      },
    }),
  ).toMatchObject({ action: 'allow', satisfyId: OBLIGATION_UUID })
  expect(
    decide({
      floors: [artifact],
      evidence: {
        ...presentArtifact,
        satisfy: {
          id: OBLIGATION_UUID,
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
    { id: OBLIGATION_UUID, stepOrdinal: 2, stepSlug: 'merge', floor: 'command-exit' },
  ]
  const decision = decide({
    floors: [artifact],
    evidence: presentArtifact,
    finishing: true,
    openObligations: open,
  })
  expect(decision.action).toBe('refuse')
  if (decision.action === 'refuse') {
    expect(decision.message).toContain(`obligation ${OBLIGATION_UUID}`)
    expect(decision.message).toContain(`--satisfies ${OBLIGATION_UUID}`)
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
          id: OBLIGATION_UUID,
          found: true,
          open: true,
          abandoned: false,
          cursorMatches: true,
          floor: deferrableExit,
        },
      },
      finishing: true,
      openObligations: [
        { id: OBLIGATION_UUID, stepOrdinal: 2, stepSlug: 'merge', floor: 'command-exit' },
      ],
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
  expect(parseArtifactRef(`probe:${ATTACHMENT_UUID}`)).toEqual({
    kind: 'probe',
    recordId: ATTACHMENT_UUID,
  })
  expect(parseArtifactRef(`exec:${ATTACHMENT_UUID}`)).toEqual({
    kind: 'exec',
    recordId: ATTACHMENT_UUID,
  })
  expect(parseArtifactRef(`doc:project/${PLATFORM_SLUG}/uuid-keys`)).toEqual({
    kind: 'doc',
    address: `project/${PLATFORM_SLUG}/uuid-keys`,
  })
  expect(parseArtifactRef('run:8')).toEqual({ kind: 'run', id: '8' })
  expect(parseArtifactRef(`attached-text:${ATTACHMENT_UUID}`)).toEqual({
    kind: 'attached-text',
    id: ATTACHMENT_UUID,
  })
  expect(parseArtifactRef('https://github.com/acme/app/pull/15')).toEqual({
    kind: 'pull-request',
    url: 'https://github.com/acme/app/pull/15',
  })
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
  expect(
    catalogueFloors(
      ['command-exit', 'recorded-artifact'],
      [],
      'done',
      false,
      false,
      'pull-request',
    ),
  ).toEqual([pullRequestExit, pullRequestArtifact])
})

test('catalogueFloors refuses an unknown kind', () => {
  expect(() => catalogueFloors(['not-a-floor'])).toThrow('unknown floor kind "not-a-floor"')
})

test('a missing obligation is refused without a fabricated floor', () => {
  const decision = decide({
    floors: [artifact],
    evidence: { ...presentArtifact, satisfy: { id: MISSING_OBLIGATION_UUID, found: false } },
  })
  expect(decision.action).toBe('refuse')
  if (decision.action === 'refuse')
    expect(decision.message).toContain(`obligation ${MISSING_OBLIGATION_UUID} does not exist`)
})
