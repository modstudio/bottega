import { describe, expect, test } from 'bun:test'
import {
  decideFloorSatisfaction,
  type Floor,
  type FloorSatisfactionInput,
  type ValidatedEvidence,
} from './workflow-floor.ts'

const decide = (input: Partial<FloorSatisfactionInput> & Pick<FloorSatisfactionInput, 'floors'>) =>
  decideFloorSatisfaction({
    evidence: {},
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
    ...input,
  })

describe('gate command-exit evidence', () => {
  const commandExit: Floor = {
    kind: 'command-exit',
    deferrable: false,
    expectedExitCode: 0,
    expectedStatus: 'done',
    requirePullRequest: false,
    operatorRuling: false,
  }
  const failedGate: ValidatedEvidence = {
    gate: {
      recordId: '00000000-0000-4000-8000-000000000002',
      finished: true,
      exitCode: 1,
      project: null,
      commit: null,
    },
  }

  test('a non-zero gate fails unless the floor states otherwise', () => {
    expect(decide({ floors: [commandExit], evidence: failedGate }).action).toBe('refuse')
    expect(
      decide({
        floors: [{ ...commandExit, expectedExitCode: 1 }],
        evidence: failedGate,
      }).action,
    ).toBe('allow')
  })
})
