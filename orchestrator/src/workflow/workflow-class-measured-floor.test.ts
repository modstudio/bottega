import { describe, expect, test } from 'bun:test'
import type { ValidatedArtifactEvidence } from './workflow-artifact-evidence.ts'
import { decideClassMeasuredFloor } from './workflow-class-measured-floor.ts'

const artifact = (overrides: Record<string, unknown> = {}): ValidatedArtifactEvidence => ({
  artifact: { ref: 'exec:7', exists: true },
  exec: {
    id: 7,
    recordId: 'exec-record',
    command: 'rg defect | wc -l',
    argv: ['rg', 'defect'],
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
    expect(decideClassMeasuredFloor({ className: 'reader leak', artifacts: [artifact()] })).toEqual({
      met: true,
      measurement: {
        className: 'reader leak',
        command: 'rg defect | wc -l',
        execId: 7,
        count: 3,
      },
    })
  })

  test.each([
    ['missing class', undefined, [artifact()], '--class is missing'],
    ['missing artifact', 'reader leak', [], 'exactly one exec artifact'],
    ['several artifacts', 'reader leak', [artifact(), artifact()], 'exactly one exec artifact'],
    ['failed exec', 'reader leak', [artifact({ exitCode: 2 })], 'exited 2'],
    ['stale exec', 'reader leak', [artifact({ createdAfterStepActivation: false })], 'predates'],
    ['non-integer count', 'reader leak', [artifact({ output: 'many\n' })], 'non-negative integer'],
  ])('%s refuses', (_name, className, artifacts, message) => {
    expect(decideClassMeasuredFloor({ className, artifacts }).message).toContain(message)
  })
})
