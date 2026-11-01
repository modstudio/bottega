import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideFloorSatisfaction,
  type Floor,
  type FloorSatisfactionInput,
  type OpenObligation,
  type ValidatedEvidence,
} from './workflow-floor.ts'
import { floorFromObligationRow } from './workflow-obligation-floor.ts'

const ID = '00000000-0000-4000-8000-000000000011'
const base: Floor = {
  kind: 'ruling',
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: false,
}
const variants: Array<{ name: string; floor: Floor }> = [
  { name: 'agent ruling', floor: base },
  { name: 'operator ruling', floor: { ...base, operatorRuling: true } },
  { name: 'ordinary command', floor: { ...base, kind: 'command-exit' } },
  { name: 'gate command', floor: { ...base, kind: 'command-exit', commandEvidence: 'gate' } },
  {
    name: 'pull-request command',
    floor: { ...base, kind: 'command-exit', commandEvidence: 'pull-request' },
  },
  { name: 'artifact', floor: { ...base, kind: 'recorded-artifact' } },
  {
    name: 'pull-request artifact',
    floor: { ...base, kind: 'recorded-artifact', commandEvidence: 'pull-request' },
  },
  { name: 'tracker', floor: { ...base, kind: 'tracker-transition' } },
]

function decide(
  floors: Floor[],
  evidence: ValidatedEvidence = {},
  extra: Partial<FloorSatisfactionInput> = {},
) {
  return decideFloorSatisfaction({
    floors,
    evidence,
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
    ...extra,
  })
}

function namedFlags(message: string): string[] {
  return [...new Set(message.match(/--(?:artifact|gate|review|ruling|run|task)\b/g) ?? [])]
}

function evidenceFor(flag: string, floor: Floor): ValidatedEvidence {
  if (flag === '--ruling')
    return floor.operatorRuling
      ? {
          stepQuestion: {
            id: 12,
            state: 'answered-by-operator',
            answeredAt: '2026-11-01T00:00:00.000Z',
            replacement: null,
          },
          ruling: {
            id: 12,
            answered: true,
            answeredByOperator: true,
            boundToCursor: true,
            boundToStep: true,
          },
        }
      : {
          ruling: {
            id: 12,
            answered: true,
            answeredByOperator: false,
            boundToCursor: true,
            boundToStep: true,
          },
        }
  if (flag === '--review')
    return {
      review: {
        recordId: ID,
        number: 12,
        allFindingsDisposed: true,
        allLensesGraded: true,
      },
    }
  if (flag === '--gate')
    return {
      gate: { recordId: ID, finished: true, exitCode: 0, project: PLATFORM_SLUG, commit: 'abc' },
      tree: { project: PLATFORM_SLUG, commit: 'abc' },
    }
  if (flag === '--run') return { run: { id: ID, terminal: true, exitCode: 0 } }
  if (flag === '--task')
    return {
      task: {
        key: 'DEV-2015',
        status: 'done',
        statusCategory: 'done',
        mergedPullRequest: true,
        trackerStates: {},
      },
    }
  if (floor.commandEvidence === 'pull-request') {
    const url = 'https://github.com/acme/app/pull/7'
    if (floor.kind === 'recorded-artifact')
      return {
        artifact: { ref: url, exists: true },
        pullRequest: {
          url,
          repository: 'acme/app',
          projectRepository: 'acme/app',
          state: 'OPEN',
          head: 'DEV-2015-work',
          base: 'main',
          cursorBranch: 'DEV-2015-work',
          trunk: 'main',
        },
      }
    return {
      artifact: { ref: `exec:${ID}`, exists: true },
      exec: {
        id: 7,
        recordId: ID,
        command: `${PLATFORM_SLUG} pr create`,
        argv: [PLATFORM_SLUG, 'pr', 'create'],
        exitCode: 0,
        sessionMatches: true,
        sessionAdoptedCursor: false,
        createdAfterStepActivation: true,
        checkoutBranch: 'DEV-2015-work',
        headCommit: 'abc',
        cursorBranch: 'DEV-2015-work',
        output: url,
      },
      pullRequest: {
        url,
        repository: 'acme/app',
        projectRepository: 'acme/app',
        state: 'OPEN',
        head: 'DEV-2015-work',
        base: 'main',
        cursorBranch: 'DEV-2015-work',
        trunk: 'main',
      },
    }
  }
  if (floor.kind === 'command-exit')
    return {
      artifact: { ref: `exec:${ID}`, exists: true },
      exec: {
        id: 7,
        recordId: ID,
        command: 'true',
        argv: ['true'],
        exitCode: 0,
        sessionMatches: true,
        sessionAdoptedCursor: false,
        createdAfterStepActivation: true,
        checkoutBranch: 'DEV-2015-work',
        headCommit: 'abc',
        cursorBranch: 'DEV-2015-work',
        output: '',
      },
    }
  return { artifact: { ref: 'task:DEV-2015', exists: true } }
}

function expectNamedFlagsClose(message: string, floor: Floor) {
  const flags = namedFlags(message)
  for (const flag of flags) expect(decide([floor], evidenceFor(flag, floor)).action).toBe('allow')
}

for (const variant of variants) {
  test(`${variant.name} single-floor refusal names only closing evidence`, () => {
    const decision = decide([variant.floor], {
      tree: { project: PLATFORM_SLUG, commit: 'abc' },
    })
    expect(decision.action).toBe('refuse')
    if (decision.action === 'refuse') expectNamedFlagsClose(decision.message, variant.floor)
  })

  test(`${variant.name} paired with an operator ruling names alternatives that close`, () => {
    const operator = { ...base, operatorRuling: true }
    const decision = decide([variant.floor, operator], {
      tree: { project: PLATFORM_SLUG, commit: 'abc' },
    })
    expect(decision.action).toBe('refuse')
    if (decision.action !== 'refuse') return
    expect(decision.message).toContain('any one floor is enough')
    for (const flag of namedFlags(decision.message)) {
      const evidence =
        flag === '--ruling' ? evidenceFor(flag, operator) : evidenceFor(flag, variant.floor)
      expect(decide([variant.floor, operator], evidence).action).toBe('allow')
    }
  })

  test(`${variant.name} --satisfies refusal names only evidence that satisfies`, () => {
    const decision = decide([{ ...base, kind: 'tracker-transition', deferrable: true }], {
      deferReason: 'later',
      satisfy: {
        id: ID,
        found: true,
        open: true,
        abandoned: false,
        cursorMatches: true,
        floor: variant.floor,
      },
    })
    expect(decision.action).toBe('refuse')
    if (decision.action === 'refuse') {
      for (const flag of namedFlags(decision.message)) {
        const evidence = {
          ...evidenceFor(flag, variant.floor),
          satisfy: {
            id: ID,
            found: true,
            open: true,
            abandoned: false,
            cursorMatches: true,
            floor: variant.floor,
          },
        }
        expect(decide([variant.floor], evidence).action).toBe('allow')
      }
    }
  })

  test(`${variant.name} open-obligation refusal uses its reconstructed floor`, () => {
    const row = {
      id: ID,
      stepOrdinal: 2,
      stepSlug: 'acceptance',
      floor: variant.floor.kind,
      requirePullRequest: variant.floor.requirePullRequest,
      operatorRuling: variant.floor.operatorRuling,
      expectedExitCode: variant.floor.expectedExitCode,
      expectedStatus: variant.floor.expectedStatus,
      floorDeferrable: variant.floor.deferrable,
    }
    const obligationFloor = floorFromObligationRow(row)
    const open: OpenObligation = { ...row, floorDefinition: obligationFloor }
    const current: Floor =
      obligationFloor.kind === 'recorded-artifact' ? base : { ...base, kind: 'recorded-artifact' }
    const currentEvidence = evidenceFor(
      current.kind === 'ruling' ? '--ruling' : '--artifact',
      current,
    )
    const decision = decide([current], currentEvidence, {
      finishing: true,
      openObligations: [open],
    })
    expect(decision.action).toBe('refuse')
    if (decision.action !== 'refuse') return
    const flags = namedFlags(decision.message)
    expect(flags.length).toBeGreaterThan(0)
    for (const flag of flags) {
      const evidence = {
        ...evidenceFor(flag, obligationFloor),
        satisfy: {
          id: ID,
          found: true as const,
          open: true,
          abandoned: false,
          cursorMatches: true,
          floor: obligationFloor,
        },
      }
      expect(
        decide([obligationFloor], evidence, {
          finishing: true,
          openObligations: [open],
        }).action,
      ).toBe('allow')
    }
  })
}
