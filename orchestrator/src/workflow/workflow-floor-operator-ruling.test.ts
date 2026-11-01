import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideFloorSatisfaction,
  type Floor,
  type FloorSatisfactionInput,
  type ValidatedEvidence,
} from './workflow-floor.ts'

const operatorRuling: Floor = {
  kind: 'ruling',
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: true,
}
const decide = (input: Partial<FloorSatisfactionInput>) =>
  decideFloorSatisfaction({
    floors: [operatorRuling],
    evidence: {},
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
    ...input,
  })

const states: {
  name: string
  question?: NonNullable<ValidatedEvidence['stepQuestion']>
  remedy: string
}[] = [
  { name: 'no question', remedy: `${PLATFORM_SLUG} workflow await` },
  {
    name: 'open question',
    question: { id: 12, state: 'open', answeredAt: null },
    remedy: '--ruling 12',
  },
  {
    name: 'closed question',
    question: { id: 12, state: 'closed', answeredAt: null },
    remedy: `${PLATFORM_SLUG} workflow await`,
  },
  {
    name: 'operator-answered question',
    question: { id: 12, state: 'answered-by-operator', answeredAt: '2026-10-20T12:00:00.001Z' },
    remedy: '--ruling 12',
  },
  {
    name: 'agent-answered question',
    question: { id: 12, state: 'answered-by-agent', answeredAt: '2026-10-20T12:00:00.001Z' },
    remedy: `${PLATFORM_SLUG} workflow await`,
  },
]

for (const { name, question, remedy } of states) {
  for (const path of ['no --ruling', 'supplied invalid ruling'] as const) {
    test(`operator ruling refusal for ${name} through ${path} names the remedy`, () => {
      const evidence: ValidatedEvidence = question ? { stepQuestion: question } : {}
      if (path === 'supplied invalid ruling')
        evidence.ruling = {
          id: 99,
          answered: true,
          answeredByOperator: false,
          boundToCursor: true,
          boundToStep: false,
        }
      const decision = decide({ evidence })
      expect(decision.action).toBe('refuse')
      if (decision.action !== 'refuse') return
      expect(decision.message).toContain(remedy)
      if (question) expect(decision.message).toContain(String(question.id))
      if (question?.state === 'answered-by-operator' && path === 'supplied invalid ruling')
        expect(decision.message).toContain('supplied ruling 99 cannot close the step')
    })
  }
}

test('a stale operator answer points at a fresh await instead of the supplied ruling', () => {
  const answeredAt = '2026-10-20T12:00:00.000Z'
  const decision = decide({
    freshRulingAfter: answeredAt,
    evidence: {
      stepQuestion: { id: 12, state: 'answered-by-operator', answeredAt },
      ruling: {
        id: 12,
        answered: true,
        answeredByOperator: true,
        boundToCursor: true,
        boundToStep: true,
        answeredAt,
      },
    },
  })
  expect(decision.action).toBe('refuse')
  if (decision.action !== 'refuse') return
  expect(decision.message).toContain(`${PLATFORM_SLUG} workflow await`)
  expect(decision.message).not.toContain('close with `--ruling')
})
