import { expect, test } from 'bun:test'
import { decideFloorSatisfaction, type Floor, type ValidatedEvidence } from './workflow-floor.ts'

const base = {
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: false,
}
const artifact: Floor = { ...base, kind: 'recorded-artifact' }
const commandExit: Floor = { ...base, kind: 'command-exit' }
const exec = (id: number, exitCode: number) => ({
  artifact: { ref: `exec:record-${id}`, exists: true },
  exec: {
    id,
    recordId: `record-${id}`,
    command: 'true',
    argv: ['true'],
    exitCode,
    sessionMatches: true,
    sessionAdoptedCursor: false,
    createdAfterStepActivation: true,
    checkoutLocation: 'branch' as const,
    headCommit: 'abc',
    cursorBranch: 'DEV-2448-work',
    output: '',
  },
})
const decide = (floors: Floor[], evidence: ValidatedEvidence) =>
  decideFloorSatisfaction({
    floors,
    evidence,
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
  })

test('recorded-artifact is met when the second offered artifact exists', () => {
  expect(
    decide([artifact], {
      artifacts: [
        { artifact: { ref: 'doc:missing', exists: false } },
        { artifact: { ref: 'doc:present', exists: true } },
      ],
    }),
  ).toMatchObject({
    action: 'allow',
    refs: [
      { flag: '--artifact', value: 'doc:missing' },
      { flag: '--artifact', value: 'doc:present' },
    ],
  })
})

test('command-exit is met by a passing exec after a failing exec', () => {
  expect(decide([commandExit, artifact], { artifacts: [exec(4, 1), exec(5, 0)] }).action).toBe(
    'allow',
  )
})

test('command-exit failure names the first mismatching exec when none passes', () => {
  const decision = decide([commandExit, artifact], { artifacts: [exec(4, 1), exec(5, 2)] })
  expect(decision).toMatchObject({ action: 'refuse' })
  if (decision.action === 'refuse') expect(decision.message).toContain('evidence exec:4')
})

test('artifact evidence refs preserve order and record duplicates once', () => {
  expect(
    decide([artifact], {
      artifacts: [
        { artifact: { ref: 'doc:first', exists: true } },
        { artifact: { ref: 'doc:first', exists: true } },
        { artifact: { ref: 'doc:second', exists: true } },
      ],
    }),
  ).toMatchObject({
    refs: [
      { flag: '--artifact', value: 'doc:first' },
      { flag: '--artifact', value: 'doc:second' },
    ],
  })
})
