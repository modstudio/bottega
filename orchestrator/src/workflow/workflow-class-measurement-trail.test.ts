import { expect, test } from 'bun:test'
import { classMeasurementFromClosedSteps } from './workflow-class-measurement-trail.ts'
import { closedStepsFromTrail } from './workflow-cursor-trail.ts'
import { decideFloorSatisfaction, type Floor } from './workflow-floor.ts'

const floor: Floor = {
  kind: 'class-measured',
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: false,
}

test('round-trips persisted floor evidence into a trail class measurement', () => {
  const decision = decideFloorSatisfaction({
    floors: [floor],
    evidence: {
      className: 'reader leak',
      artifacts: [
        {
          artifact: { ref: 'exec:7', exists: true },
          exec: {
            id: 7,
            recordId: 'exec-record',
            command: 'rg leak | wc -l',
            argv: ['sh', '-c', 'rg leak | wc -l'],
            exitCode: 0,
            sessionMatches: true,
            sessionAdoptedCursor: false,
            createdAfterStepActivation: true,
            checkoutLocation: 'branch',
            headCommit: null,
            cursorBranch: null,
            output: '3\n',
          },
        },
      ],
    },
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
  })
  expect(decision.action).toBe('allow')
  if (decision.action !== 'allow') return
  expect(decision.refs).toContainEqual({
    flag: '--command',
    value: "'sh' '-c' 'rg leak | wc -l'",
  })
  const trail = JSON.stringify([
    {
      n: 1,
      slug: 'measure-class',
      note: 'measured',
      at: '2026-11-24T10:00:00Z',
      evidence: decision.refs,
    },
    { n: 2, slug: 'implement-fix', note: 'fixed', at: '2026-11-24T11:00:00Z' },
  ])
  expect(classMeasurementFromClosedSteps(closedStepsFromTrail(trail))).toEqual({
    className: 'reader leak',
    command: "'sh' '-c' 'rg leak | wc -l'",
    count: 3,
    implementClosedAt: '2026-11-24T11:00:00Z',
  })
})

test('returns null for missing or malformed measurement evidence', () => {
  expect(classMeasurementFromClosedSteps([])).toBeNull()
  expect(
    classMeasurementFromClosedSteps([
      {
        n: 1,
        slug: 'measure-class',
        note: 'malformed',
        at: '2026-11-24T10:00:00Z',
        evidence: [{ flag: '--count', value: 'many' }],
      },
    ]),
  ).toBeNull()
})
