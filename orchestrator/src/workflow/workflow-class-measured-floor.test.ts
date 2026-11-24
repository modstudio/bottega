import { describe, expect, test } from 'bun:test'
import type { ValidatedArtifactEvidence } from './workflow-artifact-evidence.ts'
import {
  decideClassMeasuredFloor,
  renderClassMeasurementCommand,
} from './workflow-class-measured-floor.ts'

const artifact = (overrides: Record<string, unknown> = {}): ValidatedArtifactEvidence => ({
  artifact: { ref: 'exec:7', exists: true },
  exec: {
    id: 7,
    recordId: 'exec-record',
    command: 'rg defect | wc -l',
    argv: ['sh', '-c', 'rg defect | wc -l'],
    exitCode: 0,
    sessionMatches: true,
    sessionAdoptedCursor: false,
    createdAfterStepActivation: true,
    checkoutLocation: 'branch',
    headCommit: null,
    cursorBranch: null,
    output: 'detail\n3\n',
    ...overrides,
  },
})

describe('class-measured floor', () => {
  test('records the class, command, exec and count', () => {
    expect(decideClassMeasuredFloor({ className: 'reader leak', artifacts: [artifact()] })).toEqual(
      {
        met: true,
        measurement: {
          className: 'reader leak',
          command: "'sh' '-c' 'rg defect | wc -l'",
          execId: 7,
          count: 3,
        },
      },
    )
  })

  test.each([
    ['missing class', undefined, [artifact()], '--class is missing'],
    ['missing artifact', 'reader leak', [], 'exactly one exec artifact'],
    ['several artifacts', 'reader leak', [artifact(), artifact()], 'exactly one exec artifact'],
    ['failed exec', 'reader leak', [artifact({ exitCode: 2 })], 'exited 2'],
    ['stale exec', 'reader leak', [artifact({ createdAfterStepActivation: false })], 'predates'],
    ['legacy command', 'reader leak', [artifact({ argv: null })], 'structured command'],
    [
      'withheld command',
      'reader leak',
      [artifact({ argv: null, commandWithheld: true })],
      'structured command',
    ],
    ['non-integer count', 'reader leak', [artifact({ output: 'many\n' })], 'non-negative integer'],
  ])('%s refuses', (_name, className, artifacts, message) => {
    const decision = decideClassMeasuredFloor({ className, artifacts })
    expect(decision.met ? '' : decision.message).toContain(message)
  })

  test('refuses a secret-shaped class without echoing it', () => {
    const secret = 'ghp_123456789012345678901234567890123456'
    const decision = decideClassMeasuredFloor({ className: secret, artifacts: [artifact()] })
    expect(decision.met).toBe(false)
    if (!decision.met) {
      expect(decision.message).toContain('secret-shaped')
      expect(decision.message).not.toContain(secret)
    }
  })

  test('renders structured argv with one canonical shell quoting rule', () => {
    expect(renderClassMeasurementCommand(['sh', '-c', "rg 'reader leak' | wc -l"])).toBe(
      String.raw`'sh' '-c' 'rg '\''reader leak'\'' | wc -l'`,
    )
  })

  test('floor satisfaction does not add its measurement to the input evidence', async () => {
    const { decideFloorSatisfaction } = await import('./workflow-floor.ts')
    const evidence = { className: 'reader leak', artifacts: [artifact()] }
    expect(
      decideFloorSatisfaction({
        floors: [
          {
            kind: 'class-measured',
            deferrable: false,
            expectedExitCode: 0,
            expectedStatus: 'done',
            requirePullRequest: false,
            operatorRuling: false,
          },
        ],
        evidence,
        enforcement: 'floors',
        finishing: false,
        openObligations: [],
      }).action,
    ).toBe('allow')
    expect(evidence).not.toHaveProperty('classMeasurement')
  })
})
