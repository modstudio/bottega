import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import { waitingByRun, waitingInboxEntries } from './operator-waiting.ts'

test('maps only the exact active run named by a waiting question', () => {
  const question = {
    kind: 'question' as const,
    id: 7,
    run_id: 42,
    project: PLATFORM_NAME.toLowerCase(),
    task_key: 'DEV-943',
    session_id: null,
    question: 'Which?',
    options: [],
    recommendation: null,
    why: null,
    waiting_since: '2026-09-24T12:00:00.000Z',
    answer_command: 'orch answer 42 --q7 --from-operator "<ruling>"',
  }
  const workflow = {
    ...question,
    kind: 'workflow' as const,
    id: 8,
    run_id: null,
    session_id: 'session-1',
  }
  const mapped = waitingByRun(
    [{ id: 41 }, { id: 99, root_id: 42 }, { id: 43 }],
    [question, workflow],
  )
  expect([...mapped.keys()]).toEqual(['99'])
  expect(mapped.get('99')).toBe(question)

  const second = { ...question, id: 9, question: 'And then?' }
  expect(waitingInboxEntries([question, second, workflow])).toEqual([
    { ...question, questionCount: 2 },
    { ...workflow, questionCount: 1 },
  ])
})
