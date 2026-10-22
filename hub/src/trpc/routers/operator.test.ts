import { expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../../shared/brand.ts'
import type { OperatorWaitingItem } from '../../orch.ts'
import { createOperatorRouter } from './operator.ts'

const item: OperatorWaitingItem = {
  kind: 'question',
  id: 7,
  question_record_id: '00000000-0000-4000-8000-000000000007',
  run_number: 42,
  run_record_id: '00000000-0000-4000-8000-000000000042',
  project: PLATFORM_NAME.toLowerCase(),
  task_key: 'DEV-943',
  session_id: null,
  question: 'Which?',
  options: ['A', 'B'],
  recommendation: 'A',
  why: 'Because',
  waiting_since: '2026-09-24T12:00:00.000Z',
  episode: '2026-09-24T12:00:00.000Z',
  answer_command: `${PLATFORM_SLUG} question answer 42 --q7 --from-operator "<ruling>"`,
}

test('waiting query and answer mutation use the orchestrator seam', async () => {
  const calls: unknown[] = []
  const router = createOperatorRouter({
    waiting: async () => [item],
    answer: async (...args) => {
      calls.push(args)
      return {
        outcome: 'resumed' as const,
        run_record_id: '00000000-0000-4000-8000-000000000042',
        run_number: 42,
        resumed_record_id: '00000000-0000-4000-8000-000000000043',
        resumed_number: 43,
      }
    },
    file: async (input) => {
      calls.push(['file', input])
      return {
        question_id: input.questionId,
        question_record_id: '00000000-0000-4000-8000-000000000007',
        filed_as: input.as === 'canon' ? ('canon-proposal' as const) : ('doc' as const),
        filed_ref: '12@rev-1',
        filed_record_id: null,
        filed_label: null,
        filed_at: '2026-09-25T12:00:00.000Z',
      }
    },
    emailDelay: () => 30,
    setEmailDelay: (value) => calls.push(['delay', value]),
  })
  const caller = router.createCaller({})
  expect(await caller.waiting()).toEqual([item])
  expect(
    await caller.answer({
      runId: '00000000-0000-4000-8000-000000000042',
      rulings: [{ questionId: 7, ruling: 'A' }],
    }),
  ).toEqual({
    outcome: 'resumed',
    run_record_id: '00000000-0000-4000-8000-000000000042',
    run_number: 42,
    resumed_record_id: '00000000-0000-4000-8000-000000000043',
    resumed_number: 43,
  })
  expect(await caller.file({ questionId: 7, as: 'doc' })).toEqual({
    question_id: 7,
    question_record_id: '00000000-0000-4000-8000-000000000007',
    filed_as: 'doc',
    filed_ref: '12@rev-1',
    filed_record_id: null,
    filed_label: null,
    filed_at: '2026-09-25T12:00:00.000Z',
  })
  expect(calls).toEqual([
    ['00000000-0000-4000-8000-000000000042', [{ questionId: 7, ruling: 'A' }]],
    ['file', { questionId: 7, as: 'doc' }],
  ])
  expect(await caller.emailSettings()).toEqual({ delayMinutes: 30 })
  expect(await caller.setEmailSettings({ delayMinutes: 0 })).toEqual({ delayMinutes: 0 })
  expect(calls.at(-1)).toEqual(['delay', 0])
})

test('answer mutation surfaces orchestrator refusals and validates input at the edge', async () => {
  const router = createOperatorRouter({
    waiting: async () => [],
    answer: async () => {
      throw new Error('run 42 is no longer asking')
    },
    file: async () => {
      throw new Error('question 7 is unanswered')
    },
    emailDelay: () => 30,
    setEmailDelay: () => {},
  })
  const caller = router.createCaller({})
  await expect(
    caller.answer({
      runId: '00000000-0000-4000-8000-000000000042',
      rulings: [{ questionId: 7, ruling: 'A' }],
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'run 42 is no longer asking',
  })
  await expect(
    caller.answer({
      runId: '00000000-0000-4000-8000-000000000042',
      rulings: [{ questionId: 7, ruling: '   ' }],
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  })
  await expect(caller.file({ questionId: 7, as: 'canon' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'question 7 is unanswered',
  })
  await expect(
    caller.file({ questionId: 7, as: 'doc', scope: 'canon' as never }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  })
})
