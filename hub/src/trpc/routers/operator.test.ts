import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import type { OperatorWaitingItem } from '../../orch.ts'
import { createOperatorRouter } from './operator.ts'

const item: OperatorWaitingItem = {
  kind: 'question',
  id: 7,
  project: PLATFORM_NAME.toLowerCase(),
  task_key: 'DEV-943',
  session_id: null,
  question: 'Which?',
  options: ['A', 'B'],
  recommendation: 'A',
  why: 'Because',
  waiting_since: '2026-09-24T12:00:00.000Z',
  answer_command: 'orch answer 42 --q7 --from-operator "<ruling>"',
}

test('waiting query and answer mutation use the orch seam', async () => {
  const calls: unknown[] = []
  const router = createOperatorRouter({
    waiting: async () => [item],
    answer: async (...args) => {
      calls.push(args)
      return { outcome: 'resumed' as const, message: 'resumed run 42' }
    },
  })
  const caller = router.createCaller({})
  expect(await caller.waiting()).toEqual([item])
  expect(await caller.answer({ runId: 42, questionId: 7, ruling: 'A' })).toEqual({
    outcome: 'resumed',
    message: 'resumed run 42',
  })
  expect(calls).toEqual([[42, 7, 'A']])
})

test('answer mutation surfaces orch refusals and validates input at the edge', async () => {
  const router = createOperatorRouter({
    waiting: async () => [],
    answer: async () => {
      throw new Error('run 42 is no longer asking')
    },
  })
  const caller = router.createCaller({})
  await expect(caller.answer({ runId: 42, questionId: 7, ruling: 'A' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'run 42 is no longer asking',
  })
  await expect(caller.answer({ runId: 42, questionId: 7, ruling: '   ' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  })
})
