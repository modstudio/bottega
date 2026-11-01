import { expect, test } from 'bun:test'
import {
  decideFloorSatisfaction,
  type Floor,
  type FloorSatisfactionInput,
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
const gradedReview: ValidatedEvidence = {
  review: { recordId: 'review-4', number: 4, allFindingsDisposed: true, allLensesGraded: true },
}
const decide = (input: Partial<FloorSatisfactionInput> & Pick<FloorSatisfactionInput, 'floors'>) =>
  decideFloorSatisfaction({
    evidence: {},
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
    ...input,
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
